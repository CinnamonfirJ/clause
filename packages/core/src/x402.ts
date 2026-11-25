/**
 * x402 wire format used by the Clause gateway, and a small buyer-agent client.
 *
 * x402 honesty (PRD §6): standard 402 → signed payload → response flow, with an
 * "exact"-shaped payment requirement plus a `clause` extension. Settlement is DEFERRED
 * to batch adjudication by ClauseEscrow. This is a disclosed deviation — Clause does
 * not claim full x402 spec compliance, and the "clause" scheme is not formally registered.
 */
import type { TypedDataDomain } from 'ethers';
import { b64decode, b64encode, hash8, utf8 } from './hash.js';
import { clauseDomain, SignedVoucher, signVoucher, VoucherData } from './eip712.js';
import type { TemplateId } from './rules.js';

export const X402_VERSION = 2;
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';

export const X402_DEVIATION_NOTE =
  'Exact-shaped requirement + clause extension; settlement is deferred to batch adjudication by ClauseEscrow (not immediate). Not a claim of full x402 compliance.';

export interface PaymentRequirements {
  scheme: 'exact';
  network: string; // CAIP-2, e.g. eip155:196
  amount: string; // token base units
  asset: string; // token address
  payTo: string; // ClauseEscrow address
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: string;
  extra: { settlement: 'deferred-batch'; deviation: string };
}

export interface ClauseExtension {
  callId: string;
  serviceId: string;
  circuitId: string;
  template: TemplateId;
  /** The exact quoted bytes as UTF-8 text (for humans / agents to read). */
  plaintextQuote: string;
  /** The exact quoted bytes, base64. sealedHash = first 8 bytes of SHA-256 of these bytes. */
  plaintextQuoteB64: string;
  sealedHash: string;
  quotedValue: number;
  valueDecimals: number;
  tolerance: number;
  toleranceBps: number;
  issuedAt: number;
  deadline: number;
  grace: number;
  expiry: number;
  price: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tier: 1;
  escrow: string;
  chainId: number;
  mode: 'simulated' | 'chain';
}

export interface PaymentRequiredBody {
  x402Version: number;
  error: string;
  resource: string;
  accepts: PaymentRequirements[];
  extensions: { clause: ClauseExtension };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: { voucher: SignedVoucher };
}

export type CallStatus = 'delivered' | 'failed';

export interface PaymentResponse {
  success: boolean;
  callId: string;
  receiptURL: string;
  status: CallStatus;
  settlement: 'pending';
  /** Verdict predicted by the gateway's reference model. The circuit decides on settlement. */
  expectedVerdict: 0 | 1;
  failureReason?: string;
}

export function encodeHeader(obj: unknown): string {
  return b64encode(utf8(JSON.stringify(obj)));
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64decode(value))) as T;
}

export interface QuoteCheck {
  ok: boolean;
  problems: string[];
  /** Value parsed from the plaintext quote, when it is JSON with a numeric `value` field. */
  plaintextValue?: number;
}

/**
 * Buyer-side checks before signing (PRD §6: "Buyer must approve the actual value before signing").
 * 1. The plaintext bytes hash to the sealedHash the voucher will commit to.
 * 2. If the plaintext is JSON with a `value`, it equals quotedValue.
 */
export function checkQuote(ext: ClauseExtension): QuoteCheck {
  const problems: string[] = [];
  let bytes: Uint8Array;
  try {
    bytes = b64decode(ext.plaintextQuoteB64);
  } catch {
    return { ok: false, problems: ['plaintextQuoteB64 is not valid base64'] };
  }
  if (hash8(bytes).toLowerCase() !== ext.sealedHash.toLowerCase()) {
    problems.push('sealedHash does not match the plaintext quote bytes');
  }
  if (new TextDecoder().decode(bytes) !== ext.plaintextQuote) {
    problems.push('plaintextQuote text differs from its base64 bytes');
  }
  let plaintextValue: number | undefined;
  try {
    const parsed = JSON.parse(ext.plaintextQuote);
    if (parsed && typeof parsed.value === 'number') {
      plaintextValue = parsed.value;
      if (parsed.value !== ext.quotedValue) problems.push(`quoted value ${ext.quotedValue} differs from plaintext value ${parsed.value}`);
    }
  } catch {
    /* non-JSON quotes are allowed; value check is then up to the approve hook */
  }
  return { ok: problems.length === 0, problems, plaintextValue };
}

export interface BuyerSigner {
  getAddress(): Promise<string>;
  signTypedData(domain: TypedDataDomain, types: any, value: any): Promise<string>;
}

export type ClientEvent =
  | { type: 'quote'; quote: ClauseExtension; requirements: PaymentRequirements; check: QuoteCheck }
  | { type: 'rejected'; reason: string }
  | { type: 'signed'; voucher: SignedVoucher }
  | { type: 'response'; status: number; payment?: PaymentResponse };

export interface ClauseFetchResult {
  status: number;
  ok: boolean;
  body: Uint8Array;
  text: string;
  quote?: ClauseExtension;
  voucher?: SignedVoucher;
  payment?: PaymentResponse;
  error?: string;
}

export interface ClauseClientOptions {
  signer: BuyerSigner;
  fetchImpl?: typeof fetch;
  /** Hard ceiling per call, token base units. */
  maxPrice: bigint;
  /** Final approval hook. Default: approve when checkQuote() passes and price ≤ maxPrice. */
  approve?: (quote: ClauseExtension, check: QuoteCheck) => boolean | Promise<boolean>;
  onEvent?: (e: ClientEvent) => void;
  extraHeaders?: Record<string, string>;
}

let nonceCounter = 0n;
function nextNonce(): string {
  nonceCounter += 1n;
  return (BigInt(Date.now()) * 1000n + (nonceCounter % 1000n)).toString();
}

/** x402 buyer client: GET → 402 → verify + approve quote → sign voucher → retry with PAYMENT-SIGNATURE. */
export class ClauseClient {
  constructor(private readonly opts: ClauseClientOptions) {}

  async fetch(url: string): Promise<ClauseFetchResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const emit = (e: ClientEvent) => this.opts.onEvent?.(e);
    const first = await f(url, { headers: { ...(this.opts.extraHeaders ?? {}) } });
    if (first.status !== 402) {
      const body = new Uint8Array(await first.arrayBuffer());
      return { status: first.status, ok: first.ok, body, text: new TextDecoder().decode(body) };
    }
    const required = (await first.json()) as PaymentRequiredBody;
    const quote = required.extensions?.clause;
    const requirements = required.accepts?.[0];
    if (!quote || !requirements) {
      return { status: 402, ok: false, body: new Uint8Array(), text: '', error: 'gateway did not return a clause extension' };
    }
    const check = checkQuote(quote);
    emit({ type: 'quote', quote, requirements, check });

    const price = BigInt(quote.price);
    let approved = check.ok && price <= this.opts.maxPrice;
    if (this.opts.approve) approved = approved && (await this.opts.approve(quote, check));
    if (!approved) {
      const reason = !check.ok ? check.problems.join('; ') : price > this.opts.maxPrice ? 'price above maxPrice' : 'rejected by approve hook';
      emit({ type: 'rejected', reason });
      return { status: 402, ok: false, body: new Uint8Array(), text: '', quote, error: `quote not approved: ${reason}` };
    }

    const buyer = await this.opts.signer.getAddress();
    const data: VoucherData = {
      callId: quote.callId,
      buyer,
      serviceId: quote.serviceId,
      nonce: nextNonce(),
      maxAmount: quote.price,
      sealedHash: quote.sealedHash,
      quotedValue: quote.quotedValue,
      tolerance: quote.tolerance,
      issuedAt: quote.issuedAt,
      deadline: quote.deadline,
      expiry: quote.expiry,
    };
    const voucher = await signVoucher(this.opts.signer as any, clauseDomain(quote.chainId, quote.escrow), data);
    emit({ type: 'signed', voucher });

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: requirements.network,
      payload: { voucher },
    };
    const second = await f(url, {
      headers: { ...(this.opts.extraHeaders ?? {}), [HEADER_PAYMENT_SIGNATURE]: encodeHeader(payload) },
    });
    const body = new Uint8Array(await second.arrayBuffer());
    const prHeader = second.headers.get(HEADER_PAYMENT_RESPONSE);
    const payment = prHeader ? decodeHeader<PaymentResponse>(prHeader) : undefined;
    emit({ type: 'response', status: second.status, payment });
    return {
      status: second.status,
      ok: second.ok,
      body,
      text: new TextDecoder().decode(body),
      quote,
      voucher,
      payment,
    };
  }
}
