/**
 * Terminal buyer agent — the video's "10 paid calls → kill seller at 6 → refund lands" beat.
 *
 *   npm run agent -- --gateway http://localhost:8787 --calls 10 --kill-at 6 [--service 2] [--pair EURUSD] [--key 0x…]
 *
 * Without --key it generates a throwaway key and funds it through /demo/fund.
 * --kill-at uses a session-scoped kill (pass --global to kill the seller's API for everyone).
 */
import { Wallet } from 'ethers';
import { ClauseClient } from '@clause/core';

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (name: string) => args.includes(`--${name}`);

const gateway = (opt('gateway', process.env.GATEWAY_URL ?? 'http://localhost:8787') as string).replace(/\/$/, '');
const calls = Number(opt('calls', '10'));
const killAt = Number(opt('kill-at', '0'));
const pair = opt('pair', 'EURUSD')!;
const service = opt('service');
const wallet = opt('key') ? new Wallet(opt('key')!) : Wallet.createRandom();
const session = `agent-${wallet.address.slice(2, 10).toLowerCase()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const r = await fetch(gateway + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };

console.log(`${c.bold}Clause demo agent${c.reset} ${c.dim}${wallet.address} → ${gateway}${c.reset}`);
if (!opt('key')) {
  const f = await post('/demo/fund', { address: wallet.address });
  console.log(f.status === 200 ? `funded escrow with ${f.json.amount} base units${f.json.txHash ? ` (tx ${f.json.txHash})` : ' (simulated)'}` : `fund failed: ${JSON.stringify(f.json)}`);
}

const client = new ClauseClient({ signer: wallet, maxPrice: 1_000_000n, extraHeaders: { 'X-Clause-Demo-Session': session } });
const url = service ? `${gateway}/v1/call/${service}?pair=${pair}` : `${gateway}/v1/rate?pair=${pair}`;
const ids: string[] = [];

for (let i = 1; i <= calls; i++) {
  if (killAt && i === killAt) {
    const k = await post('/demo/seller/kill', flag('global') ? {} : { session });
    console.log(`${c.red}${c.bold}✖ seller killed (${k.json.scope})${c.reset}`);
  }
  const r = await client.fetch(url);
  const id = r.payment?.callId ?? '—';
  if (r.payment) ids.push(id);
  const line = r.status === 200 ? `${c.green}200${c.reset} ${r.text.slice(0, 70)}` : `${c.red}${r.status}${c.reset} ${r.payment?.failureReason ?? r.error ?? r.text.slice(0, 80)}`;
  console.log(`#${String(i).padStart(2)} ${c.dim}${id.slice(0, 12)}…${c.reset} ${line}`);
}

console.log(`${c.dim}waiting for the crank to settle (hands off the keyboard)…${c.reset}`);
const done = new Set<string>();
for (let t = 0; t < 60 && done.size < ids.length; t++) {
  await sleep(1500);
  for (const id of ids) {
    if (done.has(id)) continue;
    const r = await fetch(`${gateway}/v1/receipts/${id}`).then((x) => x.json());
    if (['paid', 'refunded', 'reclaimed'].includes(r.outcome)) {
      done.add(id);
      const color = r.outcome === 'paid' ? c.green : c.yellow;
      console.log(`${color}${r.outcome.toUpperCase().padEnd(9)}${c.reset} ${id.slice(0, 12)}… verdict ${r.verdict ?? '—'}${r.tx?.url ? ` ${r.tx.url}` : r.tx?.hash ? ` tx ${r.tx.hash}` : ' (simulated)'}`);
    }
  }
}
if (killAt) await post('/demo/seller/revive', flag('global') ? {} : { session });
const acct = await fetch(`${gateway}/v1/accounts/${wallet.address}`).then((x) => x.json());
console.log(`${c.bold}escrow balance${c.reset} ${acct.balance} (reserved ${acct.reserved})`);
