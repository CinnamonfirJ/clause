/** Typed client for the Clause gateway. Base URL: VITE_GATEWAY_URL, else same origin (dev proxy / single-process deploy). */
import type { Clause, FieldSpec, InputFields, TemplateId } from '@clause/core';

export const GATEWAY: string = (import.meta.env.VITE_GATEWAY_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: any) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; json?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(GATEWAY + path, {
      method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
      headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: init?.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach the Clause gateway. Is it running?');
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  return body as T;
}

export type CircuitStatus = 'configured' | 'dev-mock' | 'reference-model' | 'pending-partner';

export interface GatewayConfig {
  mode: 'simulated' | 'chain';
  chainId: number;
  network: string;
  escrow: string;
  token: { address: string; symbol: string; decimals: number };
  gatewayAddress: string;
  explorerUrl: string | null;
  verdictSource: string;
  circuits: Record<TemplateId, { circuitId: string; processor: string; tapeoutUrl: string; status: CircuitStatus; name: string; rule: string; useCase: string; gateBudget: string }>;
  x402: { version: number; deviation: string };
  demo: { sellerEmbedded: boolean; fundAmount: string; services: { fxSealed?: string; fxLive?: string }; faucet: boolean };
  crankIntervalMs: number;
  voucherTtlSeconds: number;
  layout: FieldSpec[];
}

export interface Stats {
  calls: number;
  paid: number;
  refunded: number;
  reclaimed: number;
  pending: number;
  refundRate: number;
  paidVolume: string;
  refundVolume: string;
  sellerEarnings: string;
  buyers: number;
  lastRefund: { callId: string; at: number } | null;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  template: TemplateId;
  templateName: string;
  rule: string;
  circuitId: string;
  processor: string;
  circuitStatus: CircuitStatus;
  tapeoutUrl: string | null;
  price: string;
  token: { address: string; symbol: string; decimals: number };
  grace: number;
  slaSeconds: number;
  toleranceBps: number;
  valueDecimals: number;
  feeBps: number;
  payee: string;
  signer: string;
  gateway: string;
  source: 'demo' | 'seller';
  endpoint: string;
  refundRate: number;
  stats: Stats;
}

export interface Account {
  address: string;
  token: { symbol: string; decimals: number };
  balance: string;
  reserved: string;
  available: string;
  mode: string;
}

export interface CallSummary {
  callId: string;
  serviceId: string;
  state: 'in_flight' | 'attested' | 'paid' | 'refunded' | 'reclaimed' | 'skipped';
  verdict: number | null;
  expectedVerdict: number | null;
  failureReason: string | null;
  settleTx: string | null;
  settleTxUrl: string | null;
  createdAt: number;
  settledAt: number | null;
}

export interface SigCheck {
  signer: string | null;
  expected: string;
  valid: boolean | null;
  note?: string;
}

export interface Receipt {
  callId: string;
  mode: 'simulated' | 'chain';
  verdictSource: string;
  state: CallSummary['state'];
  outcome: 'paid' | 'refunded' | 'reclaimed' | 'pending' | 'stuck';
  verdict: number | null;
  expectedVerdict: number | null;
  service: { id: string; name: string; template: TemplateId; templateRule: string; circuitId: string; processor: string; circuitStatus: CircuitStatus; tapeoutUrl: string | null; grace: number; price: string; feeBps: number };
  token: { symbol: string; decimals: number };
  buyer: string;
  price: string;
  input: { hex: string; fields: InputFields; layout: FieldSpec[] } | null;
  evaluation: { verdict: 0 | 1; clauses: Clause[]; engine: string } | null;
  quote: { plaintext: string; sealedHash: string; quotedValue: number; tolerance: number; issuedAt: number; deadline: number; expiry: number; check: { ok: boolean; problems: string[] } } | null;
  delivery: { status: number | null; failureReason: string | null; body: string | null };
  signatures: { voucher: SigCheck; seller: SigCheck | null; gateway: SigCheck | null };
  attestation: { callId: string; responseHash: string; deliveredValue: number; arrival: number; statusOK: boolean; sellerSig: string; gatewaySig: string } | null;
  tx: { hash: string; url: string | null } | null;
  skipReason: string | null;
  timestamps: { created: number; attested: number | null; settled: number | null };
  links: { api: string; web: string };
}

export interface RuleTestResult {
  verdict: 0 | 1;
  clauses: Clause[];
  engine: { id: string; kind: string; note: string };
  onchain: { available: boolean; verdict?: number; agrees?: boolean; via?: string; reason?: string; circuitStatus?: string } | null;
}
