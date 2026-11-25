/**
 * End-to-end (simulated mode): real gateway HTTP server + real demo seller HTTP server +
 * real EIP-712 signatures via the x402 buyer client. No mocks of the gateway or seller.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Wallet } from 'ethers';
import {
  ClauseClient,
  clauseDomain,
  decodeHeader,
  encodeHeader,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  signVoucher,
  type PaymentRequiredBody,
  type PaymentResponse,
} from '@clause/core';
import { loadConfig } from '../src/config.ts';
import { createContext, type AppContext } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';

let ctx: AppContext;
let server: Server;
let base: string;
const sellerPort = 42000 + Math.floor(Math.random() * 1000);

async function api(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await fetch(base + path, {
    ...init,
    method: init?.json !== undefined ? 'POST' : init?.method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function agent(session: string, wallet = Wallet.createRandom()) {
  const client = new ClauseClient({
    signer: wallet,
    maxPrice: 1_000_000n,
    extraHeaders: { 'X-Clause-Demo-Session': session },
  });
  return { wallet, client };
}

before(async () => {
  const cfg = loadConfig({
    SETTLEMENT_MODE: 'simulated',
    DB_PATH: ':memory:',
    PORT: '0',
    DEMO_SELLER_PORT: String(sellerPort),
    DEMO_SELLER_ADMIN_PORT: String(sellerPort + 1),
    CRANK_INTERVAL_MS: '100000',
    DEMO_SLA_SECONDS: '3',
    DEMO_GRACE: '2',
  } as any);
  cfg.dbPath = ':memory:';
  ctx = await createContext(cfg, () => {});
  const app = createApp(ctx);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx.cfg.publicUrl = base;
});

after(async () => {
  server.close();
  await ctx.close();
});

describe('gateway e2e (simulated mode)', () => {
  test('catalog lists both rule templates', async () => {
    const r = await api('/v1/services');
    assert.equal(r.status, 200);
    const templates = r.json.services.map((s: any) => s.template).sort();
    assert.deepEqual(templates, ['B', 'E']);
    for (const s of r.json.services) assert.ok(s.circuitId && s.price && 'refundRate' in s);
  });

  test('402 carries exact-shaped accepts[] + clause extension with plaintext quote', async () => {
    const r = await api(`/v1/rate?pair=EURUSD`);
    assert.equal(r.status, 402);
    const body = r.json as PaymentRequiredBody;
    assert.equal(body.accepts[0].scheme, 'exact');
    const c = body.extensions.clause;
    assert.equal(c.tier, 1);
    assert.ok(c.plaintextQuote.includes('EURUSD'));
    assert.match(c.sealedHash, /^0x[0-9a-f]{16}$/);
    assert.ok(c.tolerance > 0, 'Template B tolerance computed from bps');
    assert.ok(r.headers.get('PAYMENT-REQUIRED'));
  });

  test('happy path: pay → deliver → crank → seller paid, receipt fully verified', async () => {
    const { wallet, client } = agent('happy');
    const f = await api('/demo/fund', { json: { address: wallet.address } });
    assert.equal(f.status, 200, f.text);
    const live = ctx.demoServiceIds.fxLive!;
    const r = await client.fetch(`${base}/v1/call/${live}?pair=EURUSD`);
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).pair, 'EURUSD');
    assert.equal(r.payment?.expectedVerdict, 1);

    const pending = await api(`/v1/accounts/${wallet.address}`);
    assert.equal(pending.json.reserved, '10000');

    const t = await api('/internal/crank', { json: {} });
    assert.equal(t.json.paid, 1);
    const rc = await api(`/v1/receipts/${r.payment!.callId}`);
    assert.equal(rc.json.outcome, 'paid');
    assert.equal(rc.json.verdict, 1);
    assert.equal(rc.json.signatures.voucher.valid, true);
    assert.equal(rc.json.signatures.seller.valid, true);
    assert.equal(rc.json.signatures.gateway.valid, true);
    assert.equal(rc.json.input.hex.length, 2 + 41 * 2);
    const acct = await api(`/v1/accounts/${wallet.address}`);
    assert.equal(acct.json.balance, String(1_000_000 - 10_000));
    assert.equal(acct.json.reserved, '0');
  });

  test('kill switch (session): seller dies mid-call → statusOK=0 → refund with zero human action', async () => {
    const { wallet, client } = agent('killme');
    await api('/demo/fund', { json: { address: wallet.address } });
    await api('/demo/seller/kill', { json: { session: 'killme' } });
    const r = await client.fetch(`${base}/v1/rate?pair=GBPUSD`);
    assert.equal(r.status, 502);
    assert.equal(r.payment?.status, 'failed');
    assert.equal(r.payment?.expectedVerdict, 0);
    assert.match(r.payment!.failureReason!, /dropped|refused|unreachable/);
    await ctx.crank.tick();
    const rc = await api(`/v1/receipts/${r.payment!.callId}`);
    assert.equal(rc.json.outcome, 'refunded');
    assert.equal(rc.json.signatures.seller.valid, null, 'failure path carries no seller signature');
    assert.equal(rc.json.signatures.gateway.valid, true);
    const acct = await api(`/v1/accounts/${wallet.address}`);
    assert.equal(acct.json.balance, '1000000', 'buyer whole again');
    await api('/demo/seller/revive', { json: { session: 'killme' } });
  });

  test('global kill: API listener closed → no quote, nothing charged; revive restores', async () => {
    await api('/demo/seller/kill', { json: {} });
    const r = await api('/v1/rate?pair=EURUSD');
    assert.equal(r.status, 503);
    assert.match(r.json.error, /nothing charged/);
    const st = await api('/demo/seller/status');
    assert.equal(st.json.running, false);
    await api('/demo/seller/revive', { json: {} });
    assert.equal((await api('/v1/rate?pair=EURUSD')).status, 402);
  });

  test('Template E: tampered bytes → hash mismatch → refund', async () => {
    const { wallet, client } = agent('tamper');
    await api('/demo/fund', { json: { address: wallet.address } });
    await api('/demo/seller/fault', { json: { session: 'tamper', fault: 'tamper' } });
    const r = await client.fetch(`${base}/v1/call/${ctx.demoServiceIds.fxSealed}?pair=EURUSD`);
    assert.equal(r.status, 200, 'data delivered, but not what was sealed');
    assert.equal(r.payment?.expectedVerdict, 0);
    await ctx.crank.tick();
    const rc = await api(`/v1/receipts/${r.payment!.callId}`);
    assert.equal(rc.json.outcome, 'refunded');
    assert.equal(rc.json.evaluation.clauses.find((c: any) => c.key === 'hashMatch').pass, false);
  });

  test('Template B: drift outside tolerance → refund', async () => {
    const { wallet, client } = agent('drift');
    await api('/demo/fund', { json: { address: wallet.address } });
    await api('/demo/seller/fault', { json: { session: 'drift', fault: 'drift' } });
    const r = await client.fetch(`${base}/v1/rate?pair=USDJPY`);
    assert.equal(r.status, 200);
    await ctx.crank.tick();
    const rc = await api(`/v1/receipts/${r.payment!.callId}`);
    assert.equal(rc.json.outcome, 'refunded');
    assert.equal(rc.json.evaluation.clauses.find((c: any) => c.key === 'withinBand').pass, false);
  });

  test('unfunded agent is refused before the seller is called', async () => {
    const { client } = agent('broke');
    const r = await client.fetch(`${base}/v1/rate?pair=EURUSD`);
    assert.equal(r.status, 402);
    assert.match(r.text, /insufficient escrow balance/);
  });

  test('replaying the same voucher is idempotent; a voucher with swapped terms is rejected', async () => {
    const { wallet } = agent('replay');
    await api('/demo/fund', { json: { address: wallet.address } });
    const q = (await api('/v1/rate?pair=EURUSD')).json as PaymentRequiredBody;
    const c = q.extensions.clause;
    const domain = clauseDomain(c.chainId, c.escrow);
    const base_ = {
      callId: c.callId, buyer: wallet.address, serviceId: c.serviceId, nonce: '1', maxAmount: c.price,
      sealedHash: c.sealedHash, quotedValue: c.quotedValue, tolerance: c.tolerance, issuedAt: c.issuedAt, deadline: c.deadline, expiry: c.expiry,
    };
    const swapped = await signVoucher(wallet, domain, { ...base_, quotedValue: c.quotedValue + 1 });
    const hdr = (v: any) => encodeHeader({ x402Version: 2, scheme: 'exact', network: q.accepts[0].network, payload: { voucher: v } });
    const bad = await api('/v1/rate?pair=EURUSD', { headers: { [HEADER_PAYMENT_SIGNATURE]: hdr(swapped) } });
    assert.equal(bad.status, 402);
    assert.match(bad.text, /terms differ/);

    const good = await signVoucher(wallet, domain, base_);
    const first = await api('/v1/rate?pair=EURUSD', { headers: { [HEADER_PAYMENT_SIGNATURE]: hdr(good) } });
    const second = await api('/v1/rate?pair=EURUSD', { headers: { [HEADER_PAYMENT_SIGNATURE]: hdr(good) } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.text, second.text, 'same bytes on replay');
    const p1 = decodeHeader<PaymentResponse>(first.headers.get(HEADER_PAYMENT_RESPONSE)!);
    const p2 = decodeHeader<PaymentResponse>(second.headers.get(HEADER_PAYMENT_RESPONSE)!);
    assert.equal(p1.callId, p2.callId);
    const acct = await api(`/v1/accounts/${wallet.address}`);
    assert.equal(acct.json.reserved, '10000', 'charged once');
  });

  test('buyer refuses a quote whose seal does not match the plaintext', async () => {
    const wallet = Wallet.createRandom();
    const client = new ClauseClient({
      signer: wallet,
      maxPrice: 1_000_000n,
      fetchImpl: (async (url: any, init: any) => {
        const res = await fetch(url, init);
        if (res.status !== 402) return res;
        const body = await res.json();
        body.extensions.clause.sealedHash = '0x0000000000000000';
        return new Response(JSON.stringify(body), { status: 402 });
      }) as typeof fetch,
    });
    const r = await client.fetch(`${base}/v1/rate?pair=EURUSD`);
    assert.equal(r.ok, false);
    assert.match(r.error!, /sealedHash/);
  });

  test('timeout reclaim: a call stranded in flight is finalized as refunded after expiry', async () => {
    const wallet = Wallet.createRandom();
    await api('/demo/fund', { json: { address: wallet.address } });
    const q = (await api('/v1/rate?pair=EURUSD')).json as PaymentRequiredBody;
    const c = q.extensions.clause;
    const v = await signVoucher(wallet, clauseDomain(c.chainId, c.escrow), {
      callId: c.callId, buyer: wallet.address, serviceId: c.serviceId, nonce: '9', maxAmount: c.price,
      sealedHash: c.sealedHash, quotedValue: c.quotedValue, tolerance: c.tolerance, issuedAt: c.issuedAt, deadline: c.deadline,
      expiry: Math.floor(Date.now() / 1000) - 1, // already expired (simulates a gateway crash mid-call)
    });
    ctx.store.insertCall({ callId: c.callId, serviceId: c.serviceId, buyer: wallet.address, voucher: v, demoSession: null });
    const t = await api('/internal/crank', { json: {} });
    assert.ok(t.json.reclaimed >= 1);
    const rc = await api(`/v1/receipts/${c.callId}`);
    assert.equal(rc.json.outcome, 'reclaimed');
    assert.equal((await api(`/v1/accounts/${wallet.address}`)).json.reserved, '0');
  });

  test('rule tester: flipping byte 28 (statusOK) flips the verdict; wrong length rejected', async () => {
    const id = ctx.demoServiceIds.fxSealed;
    const base1 = await api(`/v1/rule/${id}/test`);
    assert.equal(base1.json.verdict, 1);
    const bytes = base1.json.input.slice(2);
    const flipped = '0x' + bytes.slice(0, 56) + '00' + bytes.slice(58);
    const r = await api(`/v1/rule/${id}/test?input=${flipped}`);
    assert.equal(r.json.verdict, 0);
    assert.equal(r.json.clauses.find((c: any) => c.key === 'statusOK').pass, false);
    const onchain = await api(`/v1/rule/${id}/test?input=${flipped}&onchain=1`);
    assert.equal(onchain.json.onchain.available, false, 'simulated mode is honest about no chain');
    assert.equal((await api(`/v1/rule/${id}/test?input=0x00`)).status, 400);
  });

  test('stats and badge reflect real outcomes', async () => {
    const s = await api('/v1/stats');
    assert.ok(s.json.paid >= 1 && s.json.refunded >= 3);
    const badge = await fetch(`${base}/v1/services/${ctx.demoServiceIds.fxLive}/badge.svg`);
    assert.equal(badge.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(await badge.text(), /refund-protected/);
  });

  test('seller registration validates input and blocks unsafe upstreams when configured', async () => {
    const seller = Wallet.createRandom().address;
    const ok = await api('/v1/services', {
      json: { name: 'Test weather', template: 'B', upstreamUrl: 'https://example.com/clause', price: '5000', grace: 5, toleranceBps: 25, slaSeconds: 5, valueDecimals: 2, payee: seller, signer: seller },
    });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.template, 'B');
    const bad = await api('/v1/services', { json: { name: 'x', template: 'Z', upstreamUrl: 'https://example.com' } });
    assert.equal(bad.status, 400);
    const ftp = await api('/v1/services', { json: { name: 'x', template: 'E', upstreamUrl: 'file:///etc/passwd' } });
    assert.equal(ftp.status, 400);
    ctx.cfg.allowPrivateUpstreams = false;
    const ssrf = await api('/v1/services', { json: { name: 'x', template: 'E', upstreamUrl: 'http://127.0.0.1:22/', price: '1', payee: seller, signer: seller } });
    assert.equal(ssrf.status, 400);
    assert.match(ssrf.json.error, /private or loopback/);
    ctx.cfg.allowPrivateUpstreams = true;
  });
});
