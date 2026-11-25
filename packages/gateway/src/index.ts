import { loadConfig, loadDotEnv } from './config.js';
import { createContext } from './bootstrap.js';
import { createApp } from './app.js';

loadDotEnv();
const cfg = loadConfig();
const ctx = await createContext(cfg);
const app = createApp(ctx);
ctx.crank.start(cfg.crankIntervalMs);

const server = app.listen(cfg.port, () => {
  console.log(`
  ┌─ Clause gateway ──────────────────────────────────────────────
  │ mode          ${cfg.mode}${cfg.mode === 'simulated' ? '  (wallet-free; reference-model verdicts; no chain)' : ''}
  │ api           ${cfg.publicUrl}
  │ escrow        ${cfg.escrowAddress}  (chainId ${cfg.chainId})
  │ attester      ${ctx.attester.address}
  │ verdicts      ${ctx.settlement.verdictSource}
  │ services      ${ctx.store.listServices().map((s) => `${s.id}:${s.template}`).join(' ')}
  │ crank         every ${cfg.crankIntervalMs}ms
  └───────────────────────────────────────────────────────────────`);
});

async function shutdown() {
  server.close();
  await ctx.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
