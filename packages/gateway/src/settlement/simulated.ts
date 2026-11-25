/**
 * SIMULATED settlement — wallet-free mode (PRD §7 Sandbox: "Simulated mode wallet-free").
 *
 * A SQLite ledger that mirrors ClauseEscrow's storage and executes the same settleBatch
 * steps (including real EIP-712 signature recovery). Verdicts come from the Clause
 * REFERENCE MODEL of the rule templates — not from a taped-out circuit. Every receipt
 * produced in this mode is labelled "simulated"; nothing here touches a chain.
 */
import type { TypedDataDomain } from 'ethers';
import {
  bytesToHex,
  buildInput,
  clauseDomain,
  MAX_VOUCHER_LIFETIME,
  recoverGatewaySigner,
  recoverSellerSigner,
  recoverVoucherSigner,
  sameAddress,
  verdictOf,
  ZERO_HASH8,
} from '@clause/core';
import { nowSec, type CallRow, type ServiceRow, type Store } from '../db.js';
import type { ReclaimResult, SettleItem, SettleOutcome, Settlement } from './types.js';

const STATUS = { unused: 0, paid: 1, refunded: 2, reclaimed: 3 } as const;

export class SimulatedSettlement implements Settlement {
  readonly mode = 'simulated' as const;
  readonly verdictSource = 'Clause reference model (simulated — not the taped-out circuit)';

  constructor(
    private readonly store: Store,
    private readonly opts: { chainId: number; escrow: string; treasury: string; token: string },
  ) {}

  domain(): TypedDataDomain {
    return clauseDomain(this.opts.chainId, this.opts.escrow);
  }

  private bal(account: string, token: string): bigint {
    const r = this.store.db
      .prepare('SELECT amount FROM sim_balances WHERE account = ? AND token = ?')
      .get(account.toLowerCase(), token.toLowerCase()) as any;
    return r ? BigInt(r.amount) : 0n;
  }

  private setBal(account: string, token: string, amount: bigint) {
    this.store.db
      .prepare('INSERT INTO sim_balances (account, token, amount) VALUES (?,?,?) ON CONFLICT(account, token) DO UPDATE SET amount = excluded.amount')
      .run(account.toLowerCase(), token.toLowerCase(), amount.toString());
  }

  async balanceOf(account: string, token: string) {
    return this.bal(account, token);
  }

  async pendingWithdrawal(account: string, token: string) {
    const r = this.store.db
      .prepare('SELECT amount, requested_at FROM sim_withdrawals WHERE account = ? AND token = ?')
      .get(account.toLowerCase(), token.toLowerCase()) as any;
    return r ? { amount: BigInt(r.amount), requestedAt: Number(r.requested_at) } : { amount: 0n, requestedAt: 0 };
  }

  async callStatus(callId: string) {
    const r = this.store.db.prepare('SELECT status FROM sim_call_status WHERE call_id = ?').get(callId) as any;
    return r ? Number(r.status) : STATUS.unused;
  }

  private setStatus(callId: string, s: number) {
    this.store.db.prepare('INSERT INTO sim_call_status (call_id, status) VALUES (?, ?)').run(callId, s);
  }

  async preview(service: ServiceRow, input: Uint8Array): Promise<0 | 1> {
    return verdictOf(service.template, input);
  }

  async fund(account: string, amount: bigint) {
    this.store.tx(() => {
      // Mirrors ClauseEscrow.depositFor — simulated funds only.
      this.setBal(account, this.opts.token, this.bal(account, this.opts.token) + amount);
    });
    return { txHash: null };
  }

  /** Mirror of ClauseEscrow._settle. Returns a skip reason or a verdict. */
  private settleOne(item: SettleItem, domain: TypedDataDomain, now: number): SettleOutcome {
    const { call, service: s } = item;
    const v = call.voucher;
    const a = call.attestation!;
    const skip = (reason: string): SettleOutcome => ({ callId: call.callId, kind: 'skipped', reason, txHash: null });

    if (a.callId !== v.callId) return skip('callid-mismatch');
    if (v.serviceId !== s.id) return skip('unknown-service');
    // 1
    if (!sameAddress(recoverVoucherSigner(domain, v), v.buyer)) return skip('bad-voucher-sig');
    // 2
    if (a.statusOK || (a.sellerSig && a.sellerSig !== '0x')) {
      const r = { callId: a.callId, responseHash: a.responseHash, deliveredValue: a.deliveredValue };
      if (!sameAddress(recoverSellerSigner(domain, r, a.sellerSig), s.signer)) return skip('bad-seller-sig');
    } else if (a.responseHash.toLowerCase() !== ZERO_HASH8 || a.deliveredValue !== 0) {
      return skip('bad-failure-attestation');
    }
    if (!sameAddress(recoverGatewaySigner(domain, a), s.gateway)) return skip('bad-gateway-sig');
    // 3
    const st = this.store.db.prepare('SELECT status FROM sim_call_status WHERE call_id = ?').get(v.callId) as any;
    if (st) return skip('call-already-resolved');
    if (now > v.expiry) return skip('voucher-expired');
    const price = BigInt(s.price);
    if (BigInt(v.maxAmount) < price) return skip('max-amount-below-price');
    if (v.expiry < v.issuedAt || v.expiry - v.issuedAt > MAX_VOUCHER_LIFETIME) return skip('voucher-lifetime-too-long');
    // 4
    const w = this.store.db
      .prepare('SELECT amount, requested_at FROM sim_withdrawals WHERE account = ? AND token = ?')
      .get(v.buyer.toLowerCase(), s.token.toLowerCase()) as any;
    if (w && BigInt(w.amount) > 0n && v.issuedAt > Number(w.requested_at)) return skip('issued-after-withdraw-request');
    if (this.bal(v.buyer, s.token) < price) return skip('insufficient-balance');
    // 6–7
    const input = buildInput(v, a, s.grace);
    const verdict = verdictOf(s.template, input);
    // 5, 8
    this.setBal(v.buyer, s.token, this.bal(v.buyer, s.token) - price);
    this.setStatus(v.callId, verdict === 1 ? STATUS.paid : STATUS.refunded);
    if (verdict === 1) {
      const fee = (price * BigInt(s.feeBps)) / 10_000n;
      this.setBal(s.payee, s.token, this.bal(s.payee, s.token) + price - fee);
      if (fee) this.setBal(this.opts.treasury, s.token, this.bal(this.opts.treasury, s.token) + fee);
    } else {
      this.setBal(v.buyer, s.token, this.bal(v.buyer, s.token) + price);
    }
    // 9 — the "event" is the stored input hex on the call row.
    return { callId: call.callId, kind: 'settled', verdict, inputHex: bytesToHex(input), txHash: null };
  }

  async settleBatch(items: SettleItem[]): Promise<SettleOutcome[]> {
    const domain = this.domain();
    const now = nowSec();
    return this.store.tx(() => items.map((it) => this.settleOne(it, domain, now)));
  }

  async reclaim(call: CallRow): Promise<ReclaimResult> {
    const v = call.voucher;
    const status = await this.callStatus(call.callId);
    if (status !== STATUS.unused) return { ok: false, txHash: null, alreadyResolved: { status } };
    if (nowSec() <= v.expiry) return { ok: false, txHash: null, error: 'not-expired' };
    if (!sameAddress(recoverVoucherSigner(this.domain(), v), v.buyer)) return { ok: false, txHash: null, error: 'bad-voucher-sig' };
    this.setStatus(call.callId, STATUS.reclaimed);
    return { ok: true, txHash: null };
  }

  txUrl() {
    return null;
  }
}
