import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, getAddress, isAddress } from 'ethers';
import {
  CLAUSE_ESCROW_ABI,
  encodeHeader,
  evaluate,
  FIELD_LAYOUT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  hexToBytes,
  INPUT_LENGTH,
  mandatoryVectors,
  sameAddress,
  TEMPLATES,
  X402_DEVIATION_NOTE,
  type TemplateId,
} from '@clause/core';
import type { AppContext } from './bootstrap.js';
import { REPO_ROOT, SIM_PROCESSOR } from './config.js';
import { nowSec, type ServiceRow } from './db.js';
import { HttpError } from './gateway.js';
import { assertUpstreamAllowed } from './net-guard.js';
import type { ChainSettlement } from './settlement/chain.js';

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Tiny fixed-window rate limiter (per IP + bucket). */
function rateLimit(bucket: string, max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++h.n > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: 'rate limited — slow down' });
    }
    next();
  };
}

function demoSession(req: Request): string | null {
  const s = req.get('X-Clause-Demo-Session');
  return s && SESSION_RE.test(s) ? s : null;
}

function serviceView(ctx: AppContext, s: ServiceRow) {
  const stats = ctx.store.stats(s.id);
  const circuit = ctx.cfg.circuits[s.template];
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    template: s.template,
    templateName: TEMPLATES[s.template].name,
    rule: TEMPLATES[s.template].rule,
    circuitId: s.circuitId,
    processor: s.processor,
    circuitStatus: circuit.status,
    tapeoutUrl: circuit.tapeoutUrl || null,
    price: s.price,
    token: { address: s.token, symbol: ctx.cfg.token.symbol, decimals: ctx.cfg.token.decimals },
    grace: s.grace,
    slaSeconds: s.slaSeconds,
    toleranceBps: s.toleranceBps,
    valueDecimals: s.valueDecimals,
    feeBps: s.feeBps,
    payee: s.payee,
    signer: s.signer,
    gateway: s.gateway,
    source: s.source,
    endpoint: `${ctx.cfg.publicUrl}/v1/call/${s.id}`,
    refundRate: stats.refundRate,
    stats,
    createdAt: s.createdAt,
  };
}

function badgeSvg(label: string, value: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const lw = 58;
  const vw = Math.max(120, value.length * 6.6 + 16);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${w}" height="22" rx="3" fill="#14140f"/>
<rect x="${lw}" width="${vw}" height="22" rx="3" fill="#f3efe4"/>
<rect x="${lw}" width="4" height="22" fill="#f3efe4"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="11">
<text x="9" y="15" fill="#f3efe4" font-weight="700" letter-spacing="1">${esc(label)}</text>
<text x="${lw + 8}" y="15" fill="#14140f">${esc(value)}</text>
</g></svg>`;
}

export function createApp(ctx: AppContext) {
  const { cfg, store, gateway, settlement, crank } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // CORS — the frontend may be served from DeWEB / TapeKit on a different origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${HEADER_PAYMENT_SIGNATURE}, X-Clause-Demo-Session, Authorization`);
    res.setHeader('Access-Control-Expose-Headers', `${HEADER_PAYMENT_RESPONSE}, ${HEADER_PAYMENT_REQUIRED}`);
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  // ─── Meta ─────────────────────────────────────────────────────────────────
  app.get('/v1/health', (_req, res) => {
    res.json({ ok: true, mode: cfg.mode, time: nowSec() });
  });

  app.get('/v1/config', (_req, res) => {
    res.json({
      mode: cfg.mode,
      chainId: cfg.chainId,
      network: `eip155:${cfg.chainId}`,
      escrow: cfg.escrowAddress,
      token: cfg.token,
      gatewayAddress: ctx.attester.address,
      explorerUrl: cfg.explorerUrl || null,
      verdictSource: settlement.verdictSource,
      circuits: {
        E: { ...cfg.circuits.E, ...TEMPLATES.E },
        B: { ...cfg.circuits.B, ...TEMPLATES.B },
      },
      x402: { version: 2, deviation: X402_DEVIATION_NOTE },
      demo: {
        sellerEmbedded: cfg.demo.sellerEmbedded,
        fundAmount: cfg.demo.fundAmount.toString(),
        services: ctx.demoServiceIds,
        faucet: cfg.mode === 'simulated' || !!cfg.demo.funderPrivateKey,
      },
      crankIntervalMs: cfg.crankIntervalMs,
      voucherTtlSeconds: cfg.voucherTtlSeconds,
      inputLength: INPUT_LENGTH,
      layout: FIELD_LAYOUT,
    });
  });

  app.get('/v1/stats', (_req, res) => {
    res.json({ ...store.stats(), mode: cfg.mode, services: store.listServices().length, crank: { last: crank.last, ticks: crank.totalTicks } });
  });

  // ─── Services (catalog + seller console) ─────────────────────────────────
  app.get('/v1/services', (_req, res) => {
    res.json({ services: store.listServices().map((s) => serviceView(ctx, s)) });
  });

  app.get('/v1/services/:id', (req, res) => {
    const s = store.getService(req.params.id);
    if (!s) throw new HttpError(404, 'unknown service');
    res.json(serviceView(ctx, s));
  });

  app.get('/v1/services/:id/badge.svg', (req, res) => {
    const s = store.getService(req.params.id);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (!s) return res.status(404).send(badgeSvg('CLAUSE', 'unknown service'));
    const st = store.stats(s.id);
    const rate = st.paid + st.refunded ? `${(st.refundRate * 100).toFixed(1)}% refunded` : 'no calls yet';
    res.send(badgeSvg('CLAUSE', `refund-protected · ${s.template} · ${rate}`));
  });

  app.post('/v1/services', rateLimit('register', 20, 60_000), async (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    const template = b.template as TemplateId;
    if (!name || name.length > 80) throw new HttpError(400, 'name is required (≤ 80 chars)');
    if (template !== 'E' && template !== 'B') throw new HttpError(400, 'template must be E or B');
    const upstream = String(b.upstreamUrl ?? '').trim();
    try {
      await assertUpstreamAllowed(upstream, cfg.allowPrivateUpstreams);
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
    const toleranceBps = template === 'B' ? Number(b.toleranceBps ?? 0) : 0;
    const slaSeconds = Number(b.slaSeconds ?? 10);
    const valueDecimals = Number(b.valueDecimals ?? 0);
    if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 10_000) throw new HttpError(400, 'toleranceBps must be 0–10000');
    if (!Number.isInteger(slaSeconds) || slaSeconds < 1 || slaSeconds > 300) throw new HttpError(400, 'slaSeconds must be 1–300');
    if (!Number.isInteger(valueDecimals) || valueDecimals < 0 || valueDecimals > 9) throw new HttpError(400, 'valueDecimals must be 0–9');
    const description = String(b.description ?? '').slice(0, 280);

    let row: ServiceRow;
    if (cfg.mode === 'simulated') {
      const price = String(b.price ?? '');
      const grace = Number(b.grace ?? 5);
      if (!/^\d{1,28}$/.test(price) || BigInt(price) === 0n) throw new HttpError(400, 'price must be a positive integer in token base units');
      if (!Number.isInteger(grace) || grace < 0 || grace > 3600) throw new HttpError(400, 'grace must be 0–3600 seconds');
      if (!isAddress(b.payee) || !isAddress(b.signer)) throw new HttpError(400, 'payee and signer must be addresses');
      row = {
        id: store.nextSimServiceId(),
        name,
        template,
        circuitId: cfg.circuits[template].circuitId,
        processor: SIM_PROCESSOR,
        payee: getAddress(b.payee),
        signer: getAddress(b.signer),
        gateway: ctx.attester.address,
        token: cfg.token.address,
        price,
        grace,
        feeBps: 100,
        toleranceBps,
        slaSeconds,
        valueDecimals,
        upstreamUrl: upstream,
        description,
        source: 'seller',
        registerTx: null,
        createdAt: nowSec(),
      };
    } else {
      // Chain mode: the seller registered on-chain with their own wallet; we index it after verifying.
      const id = String(b.serviceId ?? '');
      if (!/^\d+$/.test(id)) throw new HttpError(400, 'serviceId (from the ServiceRegistered event) is required in chain mode');
      if (store.getService(id)) throw new HttpError(409, 'service already indexed');
      const escrow = new Contract(cfg.escrowAddress, CLAUSE_ESCROW_ABI as unknown as string[], (settlement as ChainSettlement).provider);
      let s: any;
      try {
        s = await escrow.getService(BigInt(id));
      } catch {
        throw new HttpError(404, 'service not found on-chain');
      }
      if (!sameAddress(s.gateway, ctx.attester.address)) throw new HttpError(400, `service gateway ${s.gateway} is not this gateway (${ctx.attester.address})`);
      const circuitId = s.circuitId.toString();
      const tpl: TemplateId | null = circuitId === cfg.circuits.E.circuitId ? 'E' : circuitId === cfg.circuits.B.circuitId ? 'B' : null;
      if (!tpl) throw new HttpError(400, `circuit ${circuitId} is not a known Clause template`);
      row = {
        id,
        name,
        template: tpl,
        circuitId,
        processor: getAddress(s.processor),
        payee: getAddress(s.payee),
        signer: getAddress(s.signer),
        gateway: getAddress(s.gateway),
        token: getAddress(s.token),
        price: s.price.toString(),
        grace: Number(s.grace),
        feeBps: Number(s.feeBps),
        toleranceBps: tpl === 'B' ? toleranceBps : 0,
        slaSeconds,
        valueDecimals,
        upstreamUrl: upstream,
        description,
        source: 'seller',
        registerTx: typeof b.txHash === 'string' ? b.txHash : null,
        createdAt: nowSec(),
      };
    }
    store.insertService(row);
    res.status(201).json(serviceView(ctx, row));
  });

  // ─── x402 paid endpoints ──────────────────────────────────────────────────
  async function x402(req: Request, res: Response, serviceId: string | undefined) {
    if (!serviceId) throw new HttpError(404, 'no service configured for this route');
    const service = store.getService(serviceId);
    if (!service) throw new HttpError(404, 'unknown service');
    const session = demoSession(req);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'service' || typeof v !== 'string') continue;
      if (k.length > 64 || v.length > 256) throw new HttpError(400, 'query parameter too long');
      query.set(k, v);
    }
    const resource = `${cfg.publicUrl}${req.originalUrl.split('?')[0]}`;
    const sig = req.get(HEADER_PAYMENT_SIGNATURE);
    if (!sig) {
      const body = await gateway.quote(service, query, resource, session);
      res.status(402).setHeader(HEADER_PAYMENT_REQUIRED, encodeHeader(body));
      return res.json(body);
    }
    const r = await gateway.pay(service, query, sig, session);
    res.status(r.status).setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(r.payment));
    res.setHeader('Content-Type', r.contentType);
    res.send(Buffer.from(r.body));
  }

  app.get('/v1/rate', (req, res) => x402(req, res, (req.query.service as string) || ctx.demoServiceIds.fxLive));
  app.get('/v1/call/:serviceId', (req, res) => x402(req, res, req.params.serviceId));

  // ─── Receipts & calls ─────────────────────────────────────────────────────
  app.get('/v1/receipts/:callId', (req, res) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.params.callId)) throw new HttpError(400, 'callId must be bytes32 hex');
    res.json(gateway.receipt(req.params.callId));
  });

  app.get('/v1/calls', (req, res) => {
    const buyer = typeof req.query.buyer === 'string' && isAddress(req.query.buyer) ? req.query.buyer : undefined;
    const session = typeof req.query.session === 'string' && SESSION_RE.test(req.query.session) ? req.query.session : undefined;
    const serviceId = typeof req.query.service === 'string' ? req.query.service : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const calls = store.listCalls({ buyer, session, serviceId, limit }).map((c) => ({
      callId: c.callId,
      serviceId: c.serviceId,
      buyer: c.buyer,
      state: c.state,
      verdict: c.verdict,
      expectedVerdict: c.expectedVerdict,
      failureReason: c.failureReason,
      skipReason: c.skipReason,
      settleTx: c.settleTx,
      settleTxUrl: settlement.txUrl(c.settleTx),
      createdAt: c.createdAt,
      settledAt: c.settledAt,
    }));
    res.json({ calls });
  });

  // ─── Accounts ─────────────────────────────────────────────────────────────
  app.get('/v1/accounts/:address', async (req, res) => {
    if (!isAddress(req.params.address)) throw new HttpError(400, 'invalid address');
    const addr = getAddress(req.params.address);
    const [balance, pw] = await Promise.all([settlement.balanceOf(addr, cfg.token.address), settlement.pendingWithdrawal(addr, cfg.token.address)]);
    const reserved = store.exposure(addr, cfg.token.address);
    res.json({
      address: addr,
      token: cfg.token,
      balance: balance.toString(),
      reserved: reserved.toString(),
      available: (balance - reserved).toString(),
      pendingWithdrawal: { amount: pw.amount.toString(), requestedAt: pw.requestedAt },
      mode: cfg.mode,
    });
  });

  // ─── Rule tester (gas-free) ───────────────────────────────────────────────
  async function ruleTest(req: Request, res: Response) {
    const s = store.getService(req.params.serviceId as string);
    if (!s) throw new HttpError(404, 'unknown service');
    const src = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
    let inputHex = typeof src.input === 'string' ? src.input : undefined;
    if (!inputHex && typeof src.callId === 'string') inputHex = store.getCall(src.callId)?.inputHex ?? undefined;
    if (!inputHex) inputHex = mandatoryVectors().find((v) => v.template === s.template)!.input;
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(inputHex);
    } catch {
      throw new HttpError(400, 'input must be hex');
    }
    if (bytes.length !== INPUT_LENGTH) throw new HttpError(400, `input must be exactly ${INPUT_LENGTH} bytes (got ${bytes.length})`);
    const e = evaluate(s.template, bytes);
    let onchain: Record<string, unknown> | null = null;
    if (src.onchain === '1' || src.onchain === true || src.onchain === 'true') {
      if (cfg.mode !== 'chain') {
        onchain = { available: false, reason: 'gateway is in simulated mode — no chain configured' };
      } else {
        try {
          const verdict = await settlement.preview(s, bytes);
          onchain = { available: true, verdict, agrees: verdict === e.verdict, via: `ClauseEscrow.previewVerdict(${s.id}) → ${s.processor}`, circuitStatus: cfg.circuits[s.template].status };
        } catch (err: any) {
          onchain = { available: false, reason: err?.shortMessage ?? err?.message ?? String(err) };
        }
      }
    }
    res.json({
      serviceId: s.id,
      template: s.template,
      rule: TEMPLATES[s.template].rule,
      ignored: TEMPLATES[s.template].ignored,
      circuitId: s.circuitId,
      input: inputHex.toLowerCase(),
      verdict: e.verdict,
      clauses: e.clauses,
      fields: e.fields,
      engine: { id: 'clause-reference-model', kind: 'reference-model', note: 'Reference model of the PRD rule. Netlist simulation is partner-owned (TapeOut).' },
      onchain,
    });
  }
  app.get('/v1/rule/:serviceId/test', ruleTest);
  app.post('/v1/rule/:serviceId/test', ruleTest);

  // ─── Crank ────────────────────────────────────────────────────────────────
  app.post('/internal/crank', rateLimit('crank', 30, 60_000), async (req, res) => {
    if (cfg.crankToken && req.get('Authorization') !== `Bearer ${cfg.crankToken}`) throw new HttpError(401, 'crank token required');
    res.json(await crank.tick());
  });

  // ─── Demo ─────────────────────────────────────────────────────────────────
  const fundLimiter = rateLimit('fund', 10, 60_000);
  app.post('/demo/fund', fundLimiter, async (req, res) => {
    const addr = req.body?.address;
    if (!isAddress(addr)) throw new HttpError(400, 'address required');
    if (cfg.mode === 'chain' && !cfg.demo.funderPrivateKey) throw new HttpError(503, 'demo faucet not configured on this gateway');
    const amount = cfg.demo.fundAmount;
    const bal = await settlement.balanceOf(addr, cfg.token.address);
    if (bal >= amount * 3n) throw new HttpError(429, 'this demo agent already has enough demo funds');
    const { txHash } = await settlement.fund(getAddress(addr), amount);
    res.json({ address: getAddress(addr), amount: amount.toString(), txHash, txUrl: settlement.txUrl(txHash), simulated: cfg.mode === 'simulated' });
  });

  async function sellerAdmin(path: string, body: unknown) {
    try {
      const r = await fetch(`${cfg.demo.sellerAdminUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      return { status: r.status, json: await r.json() };
    } catch {
      throw new HttpError(503, 'demo seller admin is unreachable');
    }
  }
  const allowGlobalKill = (process.env.DEMO_ALLOW_GLOBAL_KILL ?? 'true') === 'true';
  const demoLimiter = rateLimit('demo-seller', 60, 60_000);
  app.post('/demo/seller/kill', demoLimiter, async (req, res) => {
    const session = typeof req.body?.session === 'string' && SESSION_RE.test(req.body.session) ? req.body.session : null;
    if (!session && !allowGlobalKill) throw new HttpError(403, 'global kill disabled on this gateway; pass a session');
    const r = await sellerAdmin('/kill', { session });
    res.status(r.status).json({ scope: session ? 'session' : 'global', ...r.json });
  });
  app.post('/demo/seller/revive', demoLimiter, async (req, res) => {
    const session = typeof req.body?.session === 'string' && SESSION_RE.test(req.body.session) ? req.body.session : null;
    const r = await sellerAdmin('/revive', { session });
    res.status(r.status).json({ scope: session ? 'session' : 'global', ...r.json });
  });
  app.post('/demo/seller/fault', demoLimiter, async (req, res) => {
    const session = typeof req.body?.session === 'string' && SESSION_RE.test(req.body.session) ? req.body.session : null;
    if (!session && !allowGlobalKill) throw new HttpError(403, 'global faults disabled on this gateway; pass a session');
    const r = await sellerAdmin('/fault', { session, fault: req.body?.fault });
    res.status(r.status).json(r.json);
  });
  app.get('/demo/seller/status', async (req, res) => {
    const session = typeof req.query.session === 'string' && SESSION_RE.test(req.query.session) ? req.query.session : '';
    const r = await sellerAdmin(`/status${session ? `?session=${session}` : ''}`, undefined);
    res.status(r.status).json(r.json);
  });

  // ─── Frontend (single-process deploy) ────────────────────────────────────
  const dist = join(REPO_ROOT, 'packages', 'web', 'dist');
  if (cfg.serveWebDist && existsSync(dist)) {
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!v1\/|demo\/|internal\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use((_req, _res, next) => next(new HttpError(404, 'not found')));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.details });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    ctx.log(`unhandled: ${err?.stack ?? err}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
