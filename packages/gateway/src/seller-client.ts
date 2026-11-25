/**
 * Gateway → seller protocol ("Clause seller protocol v1"). Any seller can implement it:
 *
 *   GET {upstream}/quote?{query}
 *     200, body = the EXACT bytes being quoted (the plaintext quote)
 *     X-Clause-Value: <uint32>      quoted value (fixed-point, seller-defined decimals)
 *     X-Clause-Quote-Ref: <string>  optional, echoed back on delivery
 *
 *   GET {upstream}/deliver?{query}&quoteRef=…
 *     X-Clause-Call-Id: <bytes32>   (request header)
 *     200, body = raw response bytes (hashed exactly — never canonicalized)
 *     X-Clause-Value: <uint32>      delivered value
 *     X-Clause-Signature: <0x…>     EIP-712 SellerReceipt{callId, responseHash, deliveredValue}
 *                                   signed by the service's registered signer
 */
import { assertUpstreamAllowed } from './net-guard.js';
import type { ServiceRow } from './db.js';

export const DEMO_SESSION_HEADER = 'X-Clause-Demo-Session';

export interface SellerQuote {
  bytes: Uint8Array;
  value: number;
  quoteRef: string | null;
  contentType: string | null;
}

export type SellerDelivery =
  | { ok: true; bytes: Uint8Array; value: number; signature: string; status: number; contentType: string | null; arrivalMs: number }
  | { ok: false; reason: string; status: number | null; bytes: Uint8Array | null; contentType: string | null; arrivalMs: number };

export class SellerError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly body?: string) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;

function parseUint32(v: string | null): number | null {
  if (v === null || !/^\d{1,10}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= 0xffffffff ? n : null;
}

function upstreamUrl(service: ServiceRow, path: 'quote' | 'deliver', query: URLSearchParams) {
  const base = service.upstreamUrl.replace(/\/$/, '');
  const qs = query.toString();
  return `${base}/${path}${qs ? `?${qs}` : ''}`;
}

async function readBody(res: Response): Promise<Uint8Array> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BODY) throw new SellerError(`seller body exceeds ${MAX_BODY} bytes`);
  return buf;
}

function describeFetchError(e: any): string {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'seller timed out';
  const code = e?.cause?.code ?? e?.code;
  if (code === 'ECONNREFUSED') return 'seller refused the connection (API down)';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /socket|other side closed/i.test(String(e?.cause?.message ?? e?.message))) {
    return 'seller dropped the connection';
  }
  return `seller unreachable (${code ?? e?.message ?? 'unknown error'})`;
}

export async function fetchQuote(
  service: ServiceRow,
  query: URLSearchParams,
  opts: { timeoutMs: number; allowPrivate: boolean; demoSession?: string | null },
): Promise<SellerQuote> {
  const url = upstreamUrl(service, 'quote', query);
  await assertUpstreamAllowed(url, opts.allowPrivate);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: opts.demoSession ? { [DEMO_SESSION_HEADER]: opts.demoSession } : {},
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    throw new SellerError(describeFetchError(e));
  }
  const bytes = await readBody(res);
  if (res.status !== 200) throw new SellerError(`seller quote returned HTTP ${res.status}`, res.status, new TextDecoder().decode(bytes).slice(0, 300));
  const value = parseUint32(res.headers.get('x-clause-value'));
  if (value === null) throw new SellerError('seller quote missing a valid X-Clause-Value header');
  return { bytes, value, quoteRef: res.headers.get('x-clause-quote-ref'), contentType: res.headers.get('content-type') };
}

export async function fetchDelivery(
  service: ServiceRow,
  query: URLSearchParams,
  opts: { callId: string; quoteRef: string | null; timeoutMs: number; allowPrivate: boolean; demoSession?: string | null },
): Promise<SellerDelivery> {
  const q = new URLSearchParams(query);
  if (opts.quoteRef) q.set('quoteRef', opts.quoteRef);
  const url = upstreamUrl(service, 'deliver', q);
  const headers: Record<string, string> = { 'X-Clause-Call-Id': opts.callId };
  if (opts.demoSession) headers[DEMO_SESSION_HEADER] = opts.demoSession;
  try {
    await assertUpstreamAllowed(url, opts.allowPrivate);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'error' });
    const bytes = await readBody(res);
    const arrivalMs = Date.now();
    const contentType = res.headers.get('content-type');
    if (res.status !== 200) return { ok: false, reason: `seller returned HTTP ${res.status}`, status: res.status, bytes, contentType, arrivalMs };
    const value = parseUint32(res.headers.get('x-clause-value'));
    const signature = res.headers.get('x-clause-signature');
    if (value === null) return { ok: false, reason: 'seller response missing X-Clause-Value', status: res.status, bytes, contentType, arrivalMs };
    if (!signature) return { ok: false, reason: 'seller response missing X-Clause-Signature', status: res.status, bytes, contentType, arrivalMs };
    return { ok: true, bytes, value, signature, status: res.status, contentType, arrivalMs };
  } catch (e: any) {
    return { ok: false, reason: e instanceof SellerError ? e.message : describeFetchError(e), status: null, bytes: null, contentType: null, arrivalMs: Date.now() };
  }
}
