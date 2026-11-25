/**
 * Chain-mode end-to-end: gateway → deployed ClauseEscrow on a local hardhat node.
 * Run via `npm run test:e2e:chain` at the repo root (starts the node + deploys first).
 *
 * The processor here is the DEV MOCK (MockRuleProcessor). Against X Layer it would be the
 * partner's TapeOut processor; nothing else in this flow changes.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { CLAUSE_ESCROW_ABI, ClauseClient } from '@clause/core';
import { loadConfig } from '../src/config.ts';
import { createContext, type AppContext } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';

const run = !!process.env.DEPLOYMENT_FILE;
let ctx: AppContext;
let server: Server;
let base: string;
let escrow: Contract;

async function api(path: string, json?: unknown) {
  const res = await fetch(base + path, {
    method: json !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('chain mode e2e (local hardhat + ClauseEscrow + DEV MOCK processor)', { skip: !run && 'set DEPLOYMENT_FILE (use npm run test:e2e:chain)' }, () => {
  before(async () => {
    const port = 43000 + Math.floor(Math.random() * 500);
    const cfg = loadConfig({ ...process.env, SETTLEMENT_MODE: 'chain', DB_PATH: ':memory:', DEMO_SELLER_PORT: String(port), DEMO_SELLER_ADMIN_PORT: String(port + 1), CRANK_INTERVAL_MS: '100000' } as any);
    cfg.dbPath = ':memory:';
    ctx = await createContext(cfg, () => {});
    server = createApp(ctx).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx.cfg.publicUrl = base;
    escrow = new Contract(cfg.escrowAddress, CLAUSE_ESCROW_ABI as unknown as string[], new JsonRpcProvider(cfg.rpcUrl));
  });

  after(async () => {
    server?.close();
    await ctx?.close();
  });

  test('paid calls move funds to the seller on-chain; a killed seller refunds on-chain', async () => {
    const agent = Wallet.createRandom();
    const fund = await api('/demo/fund', { address: agent.address });
    assert.equal(fund.status, 200, JSON.stringify(fund.json));
    assert.match(fund.json.txHash, /^0x[0-9a-f]{64}$/);
    const token = ctx.cfg.token.address;
    assert.equal(await escrow.balanceOf(agent.address, token), 1_000_000n);

    const session = 'chain-e2e';
    const client = new ClauseClient({ signer: agent, maxPrice: 1_000_000n, extraHeaders: { 'X-Clause-Demo-Session': session } });
    const live = ctx.demoServiceIds.fxLive!;
    const payee = (await escrow.getService(BigInt(live))).payee;
    const payeeBefore: bigint = await escrow.balanceOf(payee, token);

    const ok = [];
    for (let i = 0; i < 3; i++) ok.push(await client.fetch(`${base}/v1/call/${live}?pair=EURUSD`));
    for (const r of ok) assert.equal(r.status, 200, r.text);

    await api('/demo/seller/kill', { session });
    const dead = await client.fetch(`${base}/v1/call/${live}?pair=EURUSD`);
    assert.equal(dead.status, 502);

    const tick = await ctx.crank.tick();
    assert.equal(tick.errors.length, 0, tick.errors.join('\n'));
    assert.equal(tick.paid, 3);
    assert.equal(tick.refunded, 1);
    assert.ok(tick.txHashes.length >= 1);

    for (const r of ok) assert.equal(await escrow.callStatus(r.payment!.callId), 1n, 'Paid on-chain');
    assert.equal(await escrow.callStatus(dead.payment!.callId), 2n, 'Refunded on-chain');
    assert.equal(await escrow.balanceOf(agent.address, token), 1_000_000n - 3n * 10_000n, 'buyer charged for 3, refunded 1');
    assert.ok((await escrow.balanceOf(payee, token)) > payeeBefore, 'seller paid on-chain');

    const receipt = await api(`/v1/receipts/${dead.payment!.callId}`);
    assert.equal(receipt.json.outcome, 'refunded');
    assert.match(receipt.json.tx.hash, /^0x[0-9a-f]{64}$/);
    assert.equal(receipt.json.input.hex.length, 84);

    const rule = await api(`/v1/rule/${live}/test?callId=${dead.payment!.callId}&onchain=1`);
    assert.equal(rule.json.verdict, 0);
    assert.equal(rule.json.onchain.available, true);
    assert.equal(rule.json.onchain.agrees, true, 'reference model == on-chain processor');
    await api('/demo/seller/revive', { session });
  });
});
