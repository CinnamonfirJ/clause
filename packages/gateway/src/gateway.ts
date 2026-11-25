/**
 * The Clause gateway (PRD §6): x402 quote → voucher verification → proxy to seller →
 * hash raw bytes → collect seller signature → attest arrival/statusOK → respond.
 * Settlement is deferred to the crank (batch adjudication by ClauseEscrow).
 */
import { Wallet } from 'ethers';
import {
  b64encode,
  buildInput,
  bytesToHex,
  checkQuote,
  decodeHeader,
  decodeInput,
  evaluate,
  FIELD_LAYOUT,
  hash8,
  hexToBytes,
  randomBytes32,
  recoverGatewaySigner,
  recoverSellerSigner,
  recoverVoucherSigner,
  sameAddress,
  signGatewayAttestation,
  TEMPLATES,
  toleranceFromBps,
  verdictOf,
  X402_DEVIATION_NOTE,
  X402_VERSION,
  ZERO_HASH8,
  type AttestationData,
  type ClauseExtension,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentResponse,
  type SignedVoucher,
} from '@clause/core';
import type { Config } from './config.js';
import { nowSec, type CallRow, type ServiceRow, type Store } from './db.js';
import { fetchDelivery, fetchQuote, SellerError } from './seller-client.js';
import type { Settlement } from './settlement/types.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface PaidResponse {
  status: number;
  body: Uint8Array;
  contentType: string;
  payment: PaymentResponse;
}

const MIN_SETTLE_WINDOW = 15; // seconds the crank needs between delivery and voucher expiry

function isHex(s: unknown, bytes: number): s is string {
  return typeof s === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(s);
}
function isU32(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
}
function isUintStr(s: unknown): s is string {
  return typeof s === 'string' && /^\d{1,30}$/.test(s);
}

export function validateVoucherShape(v: any): asserts v is SignedVoucher {
  const ok =
    v &&
    isHex(v.callId, 32) &&
    isHex(v.buyer, 20) &&
    isUintStr(v.serviceId) &&
    isUintStr(v.nonce) &&
    isUintStr(v.maxAmount) &&
    isHex(v.sealedHash, 8) &&
    isU32(v.quotedValue) &&
    isU32(v.tolerance) &&
    isU32(v.issuedAt) &&
    isU32(v.deadline) &&
    isU32(v.expiry) &&
    typeof v.sig === 'string' &&
    /^0x[0-9a-fA-F]{130}$/.test(v.sig);
  if (!ok) throw new HttpError(400, 'malformed voucher in PAYMENT-SIGNATURE');
}

export class Gateway {
  constructor(
    readonly cfg: Config,
    readonly store: Store,
    readonly settlement: Settlement,
    readonly attester: Wallet,
  ) {}

  receiptApiUrl(callId: string) {
    return `${this.cfg.publicUrl}/v1/receipts/${callId}`;
  }
  receiptWebUrl(callId: string) {
    return `${this.cfg.webUrl}/#/receipt/${callId}`;
  }

  network() {
    return `eip155:${this.cfg.chainId}`;
  }

  isDemoUpstream(service: ServiceRow) {
    return service.source === 'demo' || service.upstreamUrl.startsWith(this.cfg.demo.sellerUrl);
  }

  // ─── 1. Quote (402) ───────────────────────────────────────────────────────
  async quote(service: ServiceRow, query: URLSearchParams, resource: string, demoSession: string | null): Promise<PaymentRequiredBody> {
    let q;
    try {
      q = await fetchQuote(service, query, {
        timeoutMs: 4000,
        allowPrivate: this.cfg.allowPrivateUpstreams || this.isDemoUpstream(service),
        demoSession: this.isDemoUpstream(service) ? demoSession : null,
      });
    } catch (e) {
      if (e instanceof SellerError && e.status && e.status >= 400 && e.status < 500) {
        throw new HttpError(400, 'seller rejected the request', { seller: e.body ?? e.message });
      }
      throw new HttpError(503, 'seller unavailable — no quote issued, nothing charged', { reason: (e as Error).message });
    }

    const now = nowSec();
    const callId = randomBytes32();
    const tolerance = service.template === 'B' ? toleranceFromBps(q.value, service.toleranceBps) : 0;
    const quote = {
      callId,
      serviceId: service.id,
      query: query.toString(),
      quoteRef: q.quoteRef,
      plaintext: q.bytes,
      sealedHash: hash8(q.bytes),
      quotedValue: q.value,
      tolerance,
      issuedAt: now,
      deadline: now + service.slaSeconds,
      expiry: now + this.cfg.voucherTtlSeconds,
      price: service.price,
      demoSession,
      createdAt: now,
    };
    this.store.insertQuote(quote);

    const ext: ClauseExtension = {
      callId,
      serviceId: service.id,
      circuitId: service.circuitId,
      template: service.template,
      plaintextQuote: new TextDecoder().decode(q.bytes),
      plaintextQuoteB64: b64encode(q.bytes),
      sealedHash: quote.sealedHash,
      quotedValue: q.value,
      valueDecimals: service.valueDecimals,
      tolerance,
      toleranceBps: service.toleranceBps,
      issuedAt: quote.issuedAt,
      deadline: quote.deadline,
      grace: service.grace,
      expiry: quote.expiry,
      price: service.price,
      tokenSymbol: this.cfg.token.symbol,
      tokenDecimals: this.cfg.token.decimals,
      tier: 1,
      escrow: this.cfg.escrowAddress,
      chainId: this.cfg.chainId,
      mode: this.cfg.mode,
    };
    return {
      x402Version: X402_VERSION,
      error: 'payment required',
      resource,
      accepts: [
        {
          scheme: 'exact',
          network: this.network(),
          amount: service.price,
          asset: service.token,
          payTo: this.cfg.escrowAddress,
          maxTimeoutSeconds: this.cfg.voucherTtlSeconds,
          resource,
          description: `${service.name} — refund-protected by Clause (Template ${service.template})`,
          mimeType: 'application/json',
          extra: { settlement: 'deferred-batch', deviation: X402_DEVIATION_NOTE },
        },
      ],
      extensions: { clause: ext },
    };
  }

  // ─── 2. Paid retry ────────────────────────────────────────────────────────
  async pay(service: ServiceRow, query: URLSearchParams, header: string, demoSession: string | null): Promise<PaidResponse> {
    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(header);
    } catch {
      throw new HttpError(400, 'PAYMENT-SIGNATURE is not base64 JSON');
    }
    const v = payload?.payload?.voucher as SignedVoucher;
    validateVoucherShape(v);

    const quote = this.store.getQuote(v.callId);
    if (!quote) throw new HttpError(402, 'unknown or expired quote — request a new one');
    if (quote.serviceId !== service.id || v.serviceId !== service.id) throw new HttpError(400, 'voucher is for a different service');

    // Idempotency: a retried identical voucher returns the original outcome.
    const existing = this.store.getCall(v.callId);
    if (existing) {
      if (existing.voucher.sig.toLowerCase() !== v.sig.toLowerCase()) throw new HttpError(409, 'callId already used with a different voucher');
      if (existing.state === 'in_flight') throw new HttpError(409, 'this call is already in flight');
      return this.responseFor(existing);
    }

    // The voucher must commit to exactly the terms this gateway quoted (buyer approved them).
    const mismatches: string[] = [];
    if (v.sealedHash.toLowerCase() !== quote.sealedHash.toLowerCase()) mismatches.push('sealedHash');
    if (v.quotedValue !== quote.quotedValue) mismatches.push('quotedValue');
    if (v.tolerance !== quote.tolerance) mismatches.push('tolerance');
    if (v.deadline !== quote.deadline) mismatches.push('deadline');
    if (v.issuedAt !== quote.issuedAt) mismatches.push('issuedAt');
    if (v.expiry !== quote.expiry) mismatches.push('expiry');
    if (mismatches.length) throw new HttpError(402, 'voucher terms differ from the quote', { fields: mismatches });
    if (BigInt(v.maxAmount) < BigInt(service.price)) throw new HttpError(402, 'voucher maxAmount is below the price');

    const domain = this.settlement.domain();
    if (!sameAddress(recoverVoucherSigner(domain, v), v.buyer)) throw new HttpError(402, 'voucher signature does not recover to buyer');
    const now = nowSec();
    if (now > v.expiry - MIN_SETTLE_WINDOW) throw new HttpError(402, 'quote expired — request a new one');

    const pw = await this.settlement.pendingWithdrawal(v.buyer, service.token);
    if (pw.amount > 0n && v.issuedAt > pw.requestedAt) throw new HttpError(402, 'buyer has a pending withdrawal; new vouchers are not accepted');
    const balance = await this.settlement.balanceOf(v.buyer, service.token);

    // Synchronous section: exposure check + reservation cannot interleave with another request.
    try {
      this.store.tx(() => {
        const exposure = this.store.exposure(v.buyer, service.token);
        if (balance - exposure < BigInt(service.price)) {
          throw new HttpError(402, 'insufficient escrow balance', {
            balance: balance.toString(),
            reserved: exposure.toString(),
            price: service.price,
          });
        }
        this.store.insertCall({ callId: v.callId, serviceId: service.id, buyer: v.buyer, voucher: v, demoSession });
      });
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (/UNIQUE|PRIMARY KEY/i.test(String(e?.message))) throw new HttpError(409, 'this call is already in flight');
      throw e;
    }

    // Proxy to the seller and attest.
    const limit = quote.deadline + service.grace;
    const timeoutMs = Math.max(2000, Math.min(30_000, (limit - now + 5) * 1000));
    const d = await fetchDelivery(service, query, {
      callId: v.callId,
      quoteRef: quote.quoteRef,
      timeoutMs,
      allowPrivate: this.cfg.allowPrivateUpstreams || this.isDemoUpstream(service),
      demoSession: this.isDemoUpstream(service) ? demoSession : null,
    });
    const arrival = Math.floor(d.arrivalMs / 1000);

    let fields: Omit<AttestationData, 'sellerSig' | 'gatewaySig'>;
    let sellerSig = '0x';
    let failureReason: string | null = null;
    if (d.ok) {
      const responseHash = hash8(d.bytes);
      const receipt = { callId: v.callId, responseHash, deliveredValue: d.value };
      if (sameAddress(recoverSellerSigner(domain, receipt, d.signature), service.signer)) {
        fields = { ...receipt, arrival, statusOK: true };
        sellerSig = d.signature;
      } else {
        failureReason = 'seller signature did not match the delivered bytes';
        fields = { callId: v.callId, responseHash: ZERO_HASH8, deliveredValue: 0, arrival, statusOK: false };
      }
    } else {
      failureReason = d.reason;
      fields = { callId: v.callId, responseHash: ZERO_HASH8, deliveredValue: 0, arrival, statusOK: false };
    }
    const gatewaySig = await signGatewayAttestation(this.attester, domain, fields);
    const attestation: AttestationData = { ...fields, sellerSig, gatewaySig };
    const input = buildInput(v, attestation, service.grace);
    const expectedVerdict = verdictOf(service.template, input);
    const delivered = d.ok && failureReason === null;

    this.store.attestCall(v.callId, {
      attestation,
      responseBody: delivered ? (d as any).bytes : null,
      responseStatus: delivered ? 200 : 502,
      responseType: delivered ? (d as any).contentType : 'application/json',
      failureReason,
      expectedVerdict,
      inputHex: bytesToHex(input),
    });
    return this.responseFor(this.store.getCall(v.callId)!);
  }

  responseFor(call: CallRow): PaidResponse {
    const delivered = call.responseStatus === 200 && call.responseBody;
    const payment: PaymentResponse = {
      success: !!delivered,
      callId: call.callId,
      receiptURL: this.receiptApiUrl(call.callId),
      status: delivered ? 'delivered' : 'failed',
      settlement: 'pending',
      expectedVerdict: (call.expectedVerdict ?? 0) as 0 | 1,
      ...(call.failureReason ? { failureReason: call.failureReason } : {}),
    };
    if (delivered) {
      return { status: 200, body: call.responseBody!, contentType: call.responseType ?? 'application/octet-stream', payment };
    }
    const body = JSON.stringify({
      error: 'seller failed to deliver',
      reason: call.failureReason,
      refund: 'pending — the circuit sees statusOK = 0 and will refund this call at settlement',
      callId: call.callId,
      receiptURL: this.receiptApiUrl(call.callId),
    });
    return { status: 502, body: new TextEncoder().encode(body), contentType: 'application/json', payment };
  }

  // ─── Receipts ─────────────────────────────────────────────────────────────
  receipt(callId: string) {
    const call = this.store.getCall(callId);
    if (!call) {
      const quote = this.store.getQuote(callId);
      if (quote) throw new HttpError(404, 'quote was issued but never paid — there is no call to settle');
      throw new HttpError(404, 'unknown callId');
    }
    const service = this.store.getService(call.serviceId)!;
    const quote = this.store.getQuote(callId);
    const domain = this.settlement.domain();
    const a = call.attestation;
    const inputHex = call.inputHex ?? (a ? bytesToHex(buildInput(call.voucher, a, service.grace)) : null);
    const evaluation = inputHex ? evaluate(service.template, hexToBytes(inputHex)) : null;
    const outcome =
      call.state === 'paid' ? 'paid' : call.state === 'refunded' ? 'refunded' : call.state === 'reclaimed' ? 'reclaimed' : call.state === 'skipped' ? 'stuck' : 'pending';

    const voucherSigner = recoverVoucherSigner(domain, call.voucher);
    const sellerSigner = a && a.sellerSig !== '0x' ? recoverSellerSigner(domain, { callId: a.callId, responseHash: a.responseHash, deliveredValue: a.deliveredValue }, a.sellerSig) : null;
    const gatewaySigner = a ? recoverGatewaySigner(domain, a) : null;
    const circuit = this.cfg.circuits[service.template];

    return {
      callId,
      mode: this.cfg.mode,
      verdictSource: this.settlement.verdictSource,
      state: call.state,
      outcome,
      verdict: call.verdict,
      expectedVerdict: call.expectedVerdict,
      service: {
        id: service.id,
        name: service.name,
        template: service.template,
        templateRule: TEMPLATES[service.template].rule,
        circuitId: service.circuitId,
        processor: service.processor,
        circuitStatus: circuit.status,
        tapeoutUrl: circuit.tapeoutUrl || null,
        grace: service.grace,
        price: service.price,
        feeBps: service.feeBps,
      },
      token: this.cfg.token,
      buyer: call.voucher.buyer,
      price: service.price,
      input: inputHex
        ? {
            hex: inputHex,
            fields: decodeInput(hexToBytes(inputHex)),
            layout: FIELD_LAYOUT,
          }
        : null,
      evaluation: evaluation ? { verdict: evaluation.verdict, clauses: evaluation.clauses, engine: 'clause-reference-model' } : null,
      quote: quote
        ? {
            plaintext: new TextDecoder().decode(quote.plaintext),
            sealedHash: quote.sealedHash,
            quotedValue: quote.quotedValue,
            tolerance: quote.tolerance,
            issuedAt: quote.issuedAt,
            deadline: quote.deadline,
            expiry: quote.expiry,
            check: checkQuote({ plaintextQuote: new TextDecoder().decode(quote.plaintext), plaintextQuoteB64: b64encode(quote.plaintext), sealedHash: quote.sealedHash, quotedValue: quote.quotedValue } as ClauseExtension),
          }
        : null,
      delivery: {
        status: call.responseStatus,
        failureReason: call.failureReason,
        body: call.responseBody ? new TextDecoder().decode(call.responseBody).slice(0, 2000) : null,
      },
      voucher: call.voucher,
      attestation: a,
      signatures: {
        voucher: { signer: voucherSigner, expected: call.voucher.buyer, valid: sameAddress(voucherSigner, call.voucher.buyer) },
        seller: a
          ? a.sellerSig === '0x'
            ? { signer: null, expected: service.signer, valid: null, note: 'failure path — seller never answered, nothing to sign' }
            : { signer: sellerSigner, expected: service.signer, valid: sameAddress(sellerSigner, service.signer) }
          : null,
        gateway: a ? { signer: gatewaySigner, expected: service.gateway, valid: sameAddress(gatewaySigner, service.gateway) } : null,
      },
      tx: call.settleTx ? { hash: call.settleTx, url: this.settlement.txUrl(call.settleTx) } : null,
      skipReason: call.skipReason,
      timestamps: { created: call.createdAt, attested: call.attestedAt, settled: call.settledAt },
      links: { api: this.receiptApiUrl(callId), web: this.receiptWebUrl(callId) },
    };
  }
}
