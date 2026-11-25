/**
 * Demo FX seller — a real HTTP API that implements the Clause seller protocol and signs
 * every delivery with its own key. Rates are SYNTHETIC (a random walk around realistic
 * levels); this is demo data, labelled as such in every response.
 *
 *   API   :4100  /sealed/{quote,deliver}  → Template E service (delivers the exact sealed bytes)
 *                /live/{quote,deliver}    → Template B service (delivers a fresh rate)
 *   Admin :4101  POST /kill | /revive | /fault, GET /status
 *
 * Kill switch (PRD §6 "POST /demo/seller/kill — demo spine"):
 *   - global: the API listener is actually closed → connections are refused.
 *   - session-scoped (X-Clause-Demo-Session): the seller drops the socket for that session's
 *     requests only, so concurrent public demos don't break each other.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Wallet } from 'ethers';
import { clauseDomain, hash8, signSellerReceipt, utf8 } from '@clause/core';

export type Fault = 'none' | 'kill' | 'late' | 'drift' | 'tamper' | 'error';
export const FAULTS: Fault[] = ['none', 'kill', 'late', 'drift', 'tamper', 'error'];

export interface DemoSellerOptions {
  port: number;
  adminPort: number;
  host?: string;
  signerKey: string;
  chainId: number;
  escrow: string;
  /** How long the "late" fault waits before answering (must exceed SLA + grace). */
  lateMs?: number;
  /** Auto-revive after a global kill so a public demo heals itself. 0 = never. */
  autoReviveMs?: number;
}

const DECIMALS = 5;
const PAIRS: Record<string, number> = { EURUSD: 1.0832, GBPUSD: 1.2675, USDJPY: 151.23, AUDUSD: 0.6551, USDCHF: 0.8843 };

interface SessionState {
  fault: Fault;
  touched: number;
}

export class DemoSeller {
  readonly wallet: Wallet;
  private api?: Server;
  private admin?: Server;
  private sockets = new Set<Socket>();
  private rates = new Map<string, number>();
  private sealed = new Map<string, { bytes: Uint8Array; value: number; at: number }>();
  private sessions = new Map<string, SessionState>();
  private globalFault: Fault = 'none';
  private killedAt: number | null = null;
  private reviveTimer?: NodeJS.Timeout;
  private counter = 0;
  stats = { quotes: 0, deliveries: 0, dropped: 0 };

  constructor(readonly o: DemoSellerOptions) {
    this.wallet = new Wallet(o.signerKey);
    for (const [p, r] of Object.entries(PAIRS)) this.rates.set(p, r);
  }

  get address() {
    return this.wallet.address;
  }

  get running() {
    return this.killedAt === null;
  }

  async start() {
    await this.listenApi();
    this.admin = createServer((req, res) => this.handleAdmin(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) })));
    await new Promise<void>((r) => this.admin!.listen(this.o.adminPort, this.o.host ?? '127.0.0.1', r));
  }

  async stop() {
    clearTimeout(this.reviveTimer);
    await this.closeApi();
    await new Promise<void>((r) => (this.admin ? this.admin.close(() => r()) : r()));
  }

  private async listenApi() {
    this.api = createServer((req, res) => this.handleApi(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) })));
    this.api.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.api!.listen(this.o.port, this.o.host ?? '127.0.0.1', r));
    this.killedAt = null;
  }

  private async closeApi() {
    if (!this.api) return;
    const api = this.api;
    this.api = undefined;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => api.close(() => r()));
  }

  /** Global hard kill: the API process stops listening. */
  async kill() {
    if (!this.running) return;
    await this.closeApi();
    this.killedAt = Date.now();
    if (this.o.autoReviveMs) this.reviveTimer = setTimeout(() => void this.revive(), this.o.autoReviveMs);
  }

  async revive() {
    clearTimeout(this.reviveTimer);
    if (this.running) return;
    await this.listenApi();
  }

  setFault(session: string | null, fault: Fault) {
    if (!session) {
      this.globalFault = fault;
      return;
    }
    if (fault === 'none') this.sessions.delete(session);
    else this.sessions.set(session, { fault, touched: Date.now() });
    // keep the map bounded
    if (this.sessions.size > 5000) {
      const cutoff = Date.now() - 3600_000;
      for (const [k, v] of this.sessions) if (v.touched < cutoff) this.sessions.delete(k);
    }
  }

  faultFor(session: string | null): Fault {
    if (session) {
      const s = this.sessions.get(session);
      if (s && s.fault !== 'none') return s.fault;
    }
    return this.globalFault;
  }

  status(session: string | null) {
    return {
      seller: 'clause-demo-fx (synthetic rates)',
      signer: this.address,
      running: this.running,
      killedAt: this.killedAt,
      autoReviveMs: this.o.autoReviveMs ?? 0,
      globalFault: this.globalFault,
      sessionFault: session ? this.sessions.get(session)?.fault ?? 'none' : null,
      pairs: Object.keys(PAIRS),
      stats: this.stats,
    };
  }

  private rate(pair: string): number {
    // ±0.4 bps random walk per read, mean-reverting toward the seed level.
    const seed = PAIRS[pair];
    const cur = this.rates.get(pair)!;
    const step = cur * ((Math.random() - 0.5) * 0.8e-4);
    const next = cur + step + (seed - cur) * 0.05;
    this.rates.set(pair, next);
    return next;
  }

  private body(pair: string, rate: number, extra: Record<string, unknown> = {}) {
    const value = Math.round(rate * 10 ** DECIMALS);
    const text = JSON.stringify({
      pair,
      rate: (value / 10 ** DECIMALS).toFixed(DECIMALS),
      value,
      decimals: DECIMALS,
      asOf: Math.floor(Date.now() / 1000),
      source: 'clause-demo-fx (synthetic)',
      ...extra,
    });
    return { bytes: utf8(text), value };
  }

  private async sign(callId: string, bytes: Uint8Array, value: number) {
    const domain = clauseDomain(this.o.chainId, this.o.escrow);
    return signSellerReceipt(this.wallet, domain, { callId, responseHash: hash8(bytes), deliveredValue: value });
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://seller');
    const session = (req.headers['x-clause-demo-session'] as string | undefined) ?? null;
    if (url.pathname === '/health') return json(res, 200, { ok: true });

    const m = url.pathname.match(/^\/(sealed|live)\/(quote|deliver)$/);
    if (!m || req.method !== 'GET') return json(res, 404, { error: 'not found' });
    const [, kind, op] = m;
    const pair = (url.searchParams.get('pair') ?? '').toUpperCase();
    if (!(pair in PAIRS)) return json(res, 400, { error: `unknown pair; supported: ${Object.keys(PAIRS).join(', ')}` });

    if (op === 'quote') {
      this.stats.quotes++;
      const { bytes, value } = this.body(pair, this.rate(pair), kind === 'sealed' ? { quoteRef: `q${++this.counter}` } : {});
      const ref = `q${kind === 'sealed' ? this.counter : ++this.counter}`;
      if (kind === 'sealed') this.sealed.set(ref, { bytes, value, at: Date.now() });
      this.gcSealed();
      res.writeHead(200, { 'content-type': 'application/json', 'x-clause-value': String(value), 'x-clause-quote-ref': ref });
      return res.end(bytes);
    }

    // deliver
    const fault = this.faultFor(session);
    const callId = req.headers['x-clause-call-id'] as string | undefined;
    if (!callId || !/^0x[0-9a-fA-F]{64}$/.test(callId)) return json(res, 400, { error: 'missing X-Clause-Call-Id' });
    if (fault === 'kill') {
      this.stats.dropped++;
      req.socket.destroy(); // the seller "dies" mid-request: no response, no signature
      return;
    }
    if (fault === 'error') return json(res, 503, { error: 'upstream rate engine unavailable' });
    if (fault === 'late') await sleep(this.o.lateMs ?? 10_000);

    let bytes: Uint8Array;
    let value: number;
    if (kind === 'sealed') {
      const ref = url.searchParams.get('quoteRef') ?? '';
      const q = this.sealed.get(ref);
      if (!q) return json(res, 404, { error: 'unknown quoteRef' });
      ({ bytes, value } = q);
      if (fault === 'tamper') ({ bytes, value } = this.body(pair, this.rate(pair), { quoteRef: ref })); // different bytes than sealed
    } else {
      const rate = this.rate(pair) * (fault === 'drift' ? 1.003 : 1); // +30 bps drift
      ({ bytes, value } = this.body(pair, rate));
    }
    const signature = await this.sign(callId, bytes, value);
    this.stats.deliveries++;
    res.writeHead(200, { 'content-type': 'application/json', 'x-clause-value': String(value), 'x-clause-signature': signature });
    res.end(bytes);
  }

  private gcSealed() {
    if (this.sealed.size < 2000) return;
    const cutoff = Date.now() - 15 * 60_000;
    for (const [k, v] of this.sealed) if (v.at < cutoff) this.sealed.delete(k);
  }

  private async handleAdmin(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://admin');
    const body = req.method === 'POST' ? await readJson(req) : {};
    const session = typeof body.session === 'string' && body.session ? body.session.slice(0, 100) : url.searchParams.get('session');
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /status':
        return json(res, 200, this.status(session));
      case 'POST /kill':
        if (session) this.setFault(session, 'kill');
        else await this.kill();
        return json(res, 200, this.status(session));
      case 'POST /revive':
        if (session) this.setFault(session, 'none');
        else {
          this.globalFault = 'none';
          await this.revive();
        }
        return json(res, 200, this.status(session));
      case 'POST /fault': {
        const fault = body.fault as Fault;
        if (!FAULTS.includes(fault)) return json(res, 400, { error: `fault must be one of ${FAULTS.join(', ')}` });
        this.setFault(session, fault);
        return json(res, 200, this.status(session));
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }
}

function json(res: ServerResponse, status: number, obj: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
