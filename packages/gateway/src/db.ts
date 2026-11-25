import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TemplateId, SignedVoucher, AttestationData } from '@clause/core';

export type CallState = 'in_flight' | 'attested' | 'paid' | 'refunded' | 'reclaimed' | 'skipped';

export interface ServiceRow {
  id: string;
  name: string;
  template: TemplateId;
  circuitId: string;
  processor: string;
  payee: string;
  signer: string;
  gateway: string;
  token: string;
  price: string;
  grace: number;
  feeBps: number;
  toleranceBps: number;
  slaSeconds: number;
  valueDecimals: number;
  upstreamUrl: string;
  description: string;
  source: 'demo' | 'seller';
  registerTx: string | null;
  createdAt: number;
}

export interface QuoteRow {
  callId: string;
  serviceId: string;
  query: string;
  quoteRef: string | null;
  plaintext: Uint8Array;
  sealedHash: string;
  quotedValue: number;
  tolerance: number;
  issuedAt: number;
  deadline: number;
  expiry: number;
  price: string;
  demoSession: string | null;
  createdAt: number;
}

export interface CallRow {
  callId: string;
  serviceId: string;
  buyer: string;
  voucher: SignedVoucher;
  state: CallState;
  attestation: AttestationData | null;
  responseBody: Uint8Array | null;
  responseStatus: number | null;
  responseType: string | null;
  failureReason: string | null;
  expectedVerdict: number | null;
  verdict: number | null;
  inputHex: string | null;
  skipReason: string | null;
  settleTx: string | null;
  settleAttempts: number;
  demoSession: string | null;
  createdAt: number;
  attestedAt: number | null;
  settledAt: number | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template TEXT NOT NULL CHECK (template IN ('E','B')),
  circuit_id TEXT NOT NULL,
  processor TEXT NOT NULL,
  payee TEXT NOT NULL,
  signer TEXT NOT NULL,
  gateway TEXT NOT NULL,
  token TEXT NOT NULL,
  price TEXT NOT NULL,
  grace INTEGER NOT NULL CHECK (grace >= 0),
  fee_bps INTEGER NOT NULL,
  tolerance_bps INTEGER NOT NULL DEFAULT 0 CHECK (tolerance_bps BETWEEN 0 AND 10000),
  sla_seconds INTEGER NOT NULL DEFAULT 10 CHECK (sla_seconds > 0),
  value_decimals INTEGER NOT NULL DEFAULT 0,
  upstream_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('demo','seller')),
  register_tx TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  call_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id),
  query TEXT NOT NULL,
  quote_ref TEXT,
  plaintext BLOB NOT NULL,
  sealed_hash TEXT NOT NULL,
  quoted_value INTEGER NOT NULL,
  tolerance INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  expiry INTEGER NOT NULL,
  price TEXT NOT NULL,
  demo_session TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_created ON quotes(created_at);
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY REFERENCES quotes(call_id),
  service_id TEXT NOT NULL REFERENCES services(id),
  buyer TEXT NOT NULL,
  voucher TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight','attested','paid','refunded','reclaimed','skipped')),
  attestation TEXT,
  response_body BLOB,
  response_status INTEGER,
  response_type TEXT,
  failure_reason TEXT,
  expected_verdict INTEGER,
  verdict INTEGER,
  input_hex TEXT,
  skip_reason TEXT,
  settle_tx TEXT,
  settle_attempts INTEGER NOT NULL DEFAULT 0,
  demo_session TEXT,
  created_at INTEGER NOT NULL,
  attested_at INTEGER,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS calls_state ON calls(state);
CREATE INDEX IF NOT EXISTS calls_buyer ON calls(buyer);
CREATE INDEX IF NOT EXISTS calls_service ON calls(service_id, state);
CREATE INDEX IF NOT EXISTS calls_session ON calls(demo_session);
-- Simulated-mode ledger (mirrors ClauseEscrow storage). Unused in chain mode.
CREATE TABLE IF NOT EXISTS sim_balances (account TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (account, token));
CREATE TABLE IF NOT EXISTS sim_withdrawals (account TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, requested_at INTEGER NOT NULL, PRIMARY KEY (account, token));
CREATE TABLE IF NOT EXISTS sim_call_status (call_id TEXT PRIMARY KEY, status INTEGER NOT NULL);
`;

function toCall(r: any): CallRow {
  return {
    callId: r.call_id,
    serviceId: r.service_id,
    buyer: r.buyer,
    voucher: JSON.parse(r.voucher),
    state: r.state,
    attestation: r.attestation ? JSON.parse(r.attestation) : null,
    responseBody: r.response_body ? new Uint8Array(r.response_body) : null,
    responseStatus: r.response_status,
    responseType: r.response_type,
    failureReason: r.failure_reason,
    expectedVerdict: r.expected_verdict,
    verdict: r.verdict,
    inputHex: r.input_hex,
    skipReason: r.skip_reason,
    settleTx: r.settle_tx,
    settleAttempts: r.settle_attempts,
    demoSession: r.demo_session,
    createdAt: r.created_at,
    attestedAt: r.attested_at,
    settledAt: r.settled_at,
  };
}

function toService(r: any): ServiceRow {
  return {
    id: r.id,
    name: r.name,
    template: r.template,
    circuitId: r.circuit_id,
    processor: r.processor,
    payee: r.payee,
    signer: r.signer,
    gateway: r.gateway,
    token: r.token,
    price: r.price,
    grace: r.grace,
    feeBps: r.fee_bps,
    toleranceBps: r.tolerance_bps,
    slaSeconds: r.sla_seconds,
    valueDecimals: r.value_decimals,
    upstreamUrl: r.upstream_url,
    description: r.description,
    source: r.source,
    registerTx: r.register_tx,
    createdAt: r.created_at,
  };
}

function toQuote(r: any): QuoteRow {
  return {
    callId: r.call_id,
    serviceId: r.service_id,
    query: r.query,
    quoteRef: r.quote_ref,
    plaintext: new Uint8Array(r.plaintext),
    sealedHash: r.sealed_hash,
    quotedValue: r.quoted_value,
    tolerance: r.tolerance,
    issuedAt: r.issued_at,
    deadline: r.deadline,
    expiry: r.expiry,
    price: r.price,
    demoSession: r.demo_session,
    createdAt: r.created_at,
  };
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── kv ──
  getKv(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any;
    return r?.v;
  }
  setKv(k: string, v: string) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ── services ──
  insertService(s: ServiceRow) {
    this.db
      .prepare(
        `INSERT INTO services (id,name,template,circuit_id,processor,payee,signer,gateway,token,price,grace,fee_bps,tolerance_bps,sla_seconds,value_decimals,upstream_url,description,source,register_tx,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id, s.name, s.template, s.circuitId, s.processor, s.payee, s.signer, s.gateway, s.token, s.price, s.grace, s.feeBps,
        s.toleranceBps, s.slaSeconds, s.valueDecimals, s.upstreamUrl, s.description, s.source, s.registerTx, s.createdAt,
      );
  }
  getService(id: string): ServiceRow | undefined {
    const r = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    return r ? toService(r) : undefined;
  }
  listServices(): ServiceRow[] {
    return this.db.prepare('SELECT * FROM services ORDER BY CAST(id AS INTEGER)').all().map(toService);
  }
  nextSimServiceId(): string {
    const r = this.db.prepare('SELECT MAX(CAST(id AS INTEGER)) AS m FROM services').get() as any;
    return String((r?.m ?? 0) + 1);
  }

  // ── quotes ──
  insertQuote(q: QuoteRow) {
    this.db
      .prepare(
        `INSERT INTO quotes (call_id,service_id,query,quote_ref,plaintext,sealed_hash,quoted_value,tolerance,issued_at,deadline,expiry,price,demo_session,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(q.callId, q.serviceId, q.query, q.quoteRef, q.plaintext, q.sealedHash, q.quotedValue, q.tolerance, q.issuedAt, q.deadline, q.expiry, q.price, q.demoSession, q.createdAt);
  }
  getQuote(callId: string): QuoteRow | undefined {
    const r = this.db.prepare('SELECT * FROM quotes WHERE call_id = ?').get(callId);
    return r ? toQuote(r) : undefined;
  }
  pruneQuotes(olderThan: number) {
    this.db.prepare('DELETE FROM quotes WHERE created_at < ? AND call_id NOT IN (SELECT call_id FROM calls)').run(olderThan);
  }

  // ── calls ──
  insertCall(c: Pick<CallRow, 'callId' | 'serviceId' | 'buyer' | 'voucher' | 'demoSession'>) {
    this.db
      .prepare(`INSERT INTO calls (call_id, service_id, buyer, voucher, state, demo_session, created_at) VALUES (?,?,?,?, 'in_flight', ?, ?)`)
      .run(c.callId, c.serviceId, c.buyer.toLowerCase(), JSON.stringify(c.voucher), c.demoSession, nowSec());
  }
  getCall(callId: string): CallRow | undefined {
    const r = this.db.prepare('SELECT * FROM calls WHERE call_id = ?').get(callId);
    return r ? toCall(r) : undefined;
  }
  attestCall(callId: string, a: {
    attestation: AttestationData;
    responseBody: Uint8Array | null;
    responseStatus: number;
    responseType: string | null;
    failureReason: string | null;
    expectedVerdict: number;
    inputHex: string;
  }) {
    this.db
      .prepare(
        `UPDATE calls SET state='attested', attestation=?, response_body=?, response_status=?, response_type=?, failure_reason=?, expected_verdict=?, input_hex=?, attested_at=? WHERE call_id=? AND state='in_flight'`,
      )
      .run(JSON.stringify(a.attestation), a.responseBody, a.responseStatus, a.responseType, a.failureReason, a.expectedVerdict, a.inputHex, nowSec(), callId);
  }
  markSettled(callId: string, state: 'paid' | 'refunded', verdict: number, inputHex: string, tx: string | null) {
    this.db
      .prepare(`UPDATE calls SET state=?, verdict=?, input_hex=?, settle_tx=?, settled_at=?, skip_reason=NULL WHERE call_id=?`)
      .run(state, verdict, inputHex, tx, nowSec(), callId);
  }
  markSkipped(callId: string, reason: string, terminal: boolean) {
    this.db
      .prepare(`UPDATE calls SET skip_reason=?, settle_attempts=settle_attempts+1, state=CASE WHEN ? THEN 'skipped' ELSE state END WHERE call_id=?`)
      .run(reason, terminal ? 1 : 0, callId);
  }
  markReclaimed(callId: string, tx: string | null) {
    this.db.prepare(`UPDATE calls SET state='reclaimed', settle_tx=COALESCE(?, settle_tx), settled_at=? WHERE call_id=?`).run(tx, nowSec(), callId);
  }
  bumpAttempt(callId: string, reason: string) {
    this.db.prepare(`UPDATE calls SET settle_attempts=settle_attempts+1, skip_reason=? WHERE call_id=?`).run(reason, callId);
  }
  callsToSettle(limit: number, minExpiry: number): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM calls WHERE state='attested' AND json_extract(voucher,'$.expiry') > ? ORDER BY created_at LIMIT ?`)
      .all(minExpiry, limit)
      .map(toCall);
  }
  callsToReclaim(now: number, limit: number): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM calls WHERE state IN ('in_flight','attested','skipped') AND json_extract(voucher,'$.expiry') < ? ORDER BY created_at LIMIT ?`)
      .all(now, limit)
      .map(toCall);
  }
  /** Σ price of this buyer's calls that are not yet resolved (escrow exposure). */
  exposure(buyer: string, token: string): bigint {
    const rows = this.db
      .prepare(
        `SELECT s.price AS price FROM calls c JOIN services s ON s.id = c.service_id
         WHERE c.buyer = ? AND lower(s.token) = lower(?) AND c.state IN ('in_flight','attested','skipped')`,
      )
      .all(buyer.toLowerCase(), token) as any[];
    return rows.reduce((acc, r) => acc + BigInt(r.price), 0n);
  }
  listCalls(filter: { buyer?: string; session?: string; serviceId?: string; limit: number }): CallRow[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.buyer) {
      where.push('buyer = ?');
      args.push(filter.buyer.toLowerCase());
    }
    if (filter.session) {
      where.push('demo_session = ?');
      args.push(filter.session);
    }
    if (filter.serviceId) {
      where.push('service_id = ?');
      args.push(filter.serviceId);
    }
    args.push(filter.limit);
    return this.db
      .prepare(`SELECT * FROM calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args)
      .map(toCall);
  }

  // ── stats ──
  stats(serviceId?: string) {
    const where = serviceId ? 'WHERE c.service_id = ?' : '';
    const args = serviceId ? [serviceId] : [];
    const rows = this.db
      .prepare(
        `SELECT c.state AS state, COUNT(*) AS n, s.price AS price, s.fee_bps AS fee FROM calls c JOIN services s ON s.id = c.service_id ${where} GROUP BY c.state, s.id`,
      )
      .all(...args) as any[];
    let calls = 0, paid = 0, refunded = 0, reclaimed = 0, pending = 0;
    let paidVolume = 0n, refundVolume = 0n, earnings = 0n;
    for (const r of rows) {
      const n = Number(r.n);
      const price = BigInt(r.price);
      calls += n;
      if (r.state === 'paid') {
        paid += n;
        paidVolume += price * BigInt(n);
        earnings += (price - (price * BigInt(r.fee)) / 10_000n) * BigInt(n);
      } else if (r.state === 'refunded') {
        refunded += n;
        refundVolume += price * BigInt(n);
      } else if (r.state === 'reclaimed') {
        reclaimed += n;
        refundVolume += price * BigInt(n);
      } else pending += n;
    }
    const resolved = paid + refunded + reclaimed;
    const buyers = (this.db.prepare(`SELECT COUNT(DISTINCT buyer) AS n FROM calls c ${where}`).get(...args) as any).n;
    const lastRefund = this.db
      .prepare(`SELECT c.call_id AS callId, c.settled_at AS at FROM calls c ${where ? where + ' AND' : 'WHERE'} c.state IN ('refunded','reclaimed') ORDER BY c.settled_at DESC LIMIT 1`)
      .get(...args) as any;
    return {
      calls,
      paid,
      refunded: refunded + reclaimed,
      reclaimed,
      pending,
      refundRate: resolved ? (refunded + reclaimed) / resolved : 0,
      paidVolume: paidVolume.toString(),
      refundVolume: refundVolume.toString(),
      sellerEarnings: earnings.toString(),
      buyers: Number(buyers),
      lastRefund: lastRefund ? { callId: lastRefund.callId, at: lastRefund.at } : null,
    };
  }
}
