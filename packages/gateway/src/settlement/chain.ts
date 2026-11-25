/**
 * CHAIN settlement — the deployed ClauseEscrow on X Layer (or a local hardhat node).
 * Verdicts come from whatever processor each service registered: the partner's TapeOut
 * processor in production, or the DEV MOCK processor on a local node.
 */
import { Contract, JsonRpcProvider, NonceManager, Wallet, type TypedDataDomain } from 'ethers';
import { CLAUSE_ESCROW_ABI, clauseDomain, SKIP_REASONS } from '@clause/core';
import type { CallRow, ServiceRow } from '../db.js';
import type { ReclaimResult, SettleItem, SettleOutcome, Settlement } from './types.js';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

export interface ChainOptions {
  rpcUrl: string;
  chainId: number;
  escrow: string;
  token: string;
  crankKey: string;
  funderKey?: string;
  explorerUrl: string;
  verdictSource: string;
}

function voucherTuple(v: CallRow['voucher']) {
  return {
    callId: v.callId,
    buyer: v.buyer,
    serviceId: BigInt(v.serviceId),
    nonce: BigInt(v.nonce),
    maxAmount: BigInt(v.maxAmount),
    sealedHash: v.sealedHash,
    quotedValue: v.quotedValue,
    tolerance: v.tolerance,
    issuedAt: v.issuedAt,
    deadline: v.deadline,
    expiry: v.expiry,
    sig: v.sig,
  };
}

function attestationTuple(a: NonNullable<CallRow['attestation']>) {
  return {
    callId: a.callId,
    responseHash: a.responseHash,
    deliveredValue: a.deliveredValue,
    arrival: a.arrival,
    statusOK: a.statusOK,
    sellerSig: a.sellerSig || '0x',
    gatewaySig: a.gatewaySig,
  };
}

export class ChainSettlement implements Settlement {
  readonly mode = 'chain' as const;
  readonly verdictSource: string;
  readonly provider: JsonRpcProvider;
  readonly escrow: Contract;
  private readonly crank: NonceManager;
  private readonly funder?: NonceManager;
  private approved = false;

  constructor(private readonly o: ChainOptions) {
    this.verdictSource = o.verdictSource;
    this.provider = new JsonRpcProvider(o.rpcUrl, o.chainId, { staticNetwork: true });
    this.crank = new NonceManager(new Wallet(o.crankKey, this.provider));
    this.escrow = new Contract(o.escrow, CLAUSE_ESCROW_ABI as unknown as string[], this.crank);
    if (o.funderKey) this.funder = new NonceManager(new Wallet(o.funderKey, this.provider));
  }

  async assertReady() {
    const net = await this.provider.getNetwork();
    if (Number(net.chainId) !== this.o.chainId) throw new Error(`RPC chainId ${net.chainId} ≠ configured ${this.o.chainId}`);
    const code = await this.provider.getCode(this.o.escrow);
    if (code === '0x') throw new Error(`no contract at ESCROW_ADDRESS ${this.o.escrow}`);
  }

  domain(): TypedDataDomain {
    return clauseDomain(this.o.chainId, this.o.escrow);
  }

  async balanceOf(account: string, token: string) {
    return BigInt(await this.escrow.balanceOf(account, token));
  }

  async pendingWithdrawal(account: string, token: string) {
    const [amount, requestedAt] = await this.escrow.pendingWithdrawal(account, token);
    return { amount: BigInt(amount), requestedAt: Number(requestedAt) };
  }

  async callStatus(callId: string) {
    return Number(await this.escrow.callStatus(callId));
  }

  async preview(service: ServiceRow, input: Uint8Array): Promise<0 | 1> {
    const v = Number(await this.escrow.previewVerdict(BigInt(service.id), input));
    return v === 1 ? 1 : 0;
  }

  async settleBatch(items: SettleItem[]): Promise<SettleOutcome[]> {
    const vs = items.map((i) => voucherTuple(i.call.voucher));
    const as = items.map((i) => attestationTuple(i.call.attestation!));
    const tx = await this.escrow.settleBatch(vs, as);
    const rc = await tx.wait();
    const txHash: string = rc.hash;
    const adjudicated = new Map<string, { verdict: number; input: string }>();
    const skipped = new Map<string, string>();
    for (const log of rc.logs) {
      let parsed;
      try {
        parsed = this.escrow.interface.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.name === 'Adjudicated') adjudicated.set(parsed.args.callId.toLowerCase(), { verdict: Number(parsed.args.verdict), input: parsed.args.input });
      if (parsed.name === 'Skipped') skipped.set(parsed.args.callId.toLowerCase(), SKIP_REASONS[Number(parsed.args.reason)] ?? `reason-${parsed.args.reason}`);
    }
    return items.map(({ call }) => {
      const id = call.callId.toLowerCase();
      const adj = adjudicated.get(id);
      if (adj) return { callId: call.callId, kind: 'settled', verdict: adj.verdict === 1 ? 1 : 0, inputHex: adj.input, txHash } as const;
      return { callId: call.callId, kind: 'skipped', reason: skipped.get(id) ?? 'no-event', txHash } as const;
    });
  }

  async reclaim(call: CallRow): Promise<ReclaimResult> {
    const status = await this.callStatus(call.callId);
    if (status !== 0) return { ok: false, txHash: null, alreadyResolved: { status } };
    try {
      const tx = await this.escrow.reclaim(call.callId, voucherTuple(call.voucher));
      const rc = await tx.wait();
      return { ok: true, txHash: rc.hash };
    } catch (e: any) {
      return { ok: false, txHash: null, error: e?.shortMessage ?? e?.message ?? String(e) };
    }
  }

  async fund(account: string, amount: bigint) {
    if (!this.funder) throw new Error('DEMO_FUNDER_PRIVATE_KEY not configured — chain-mode faucet disabled');
    const token = new Contract(this.o.token, ERC20_ABI, this.funder);
    const escrow = this.escrow.connect(this.funder) as Contract;
    if (!this.approved) {
      const owner = await this.funder.getAddress();
      const allowance: bigint = await token.allowance(owner, this.o.escrow);
      if (allowance < amount * 1000n) await (await token.approve(this.o.escrow, 2n ** 255n)).wait();
      this.approved = true;
    }
    const tx = await escrow.depositFor(account, this.o.token, amount);
    const rc = await tx.wait();
    return { txHash: rc.hash as string };
  }

  txUrl(hash: string | null) {
    if (!hash) return null;
    return this.o.explorerUrl ? `${this.o.explorerUrl}/tx/${hash}` : null;
  }
}
