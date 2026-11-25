/**
 * Simulated mode (default): gateway + embedded demo seller + crank on :8787, web on :5173.
 * Zero setup — no chain, no wallet, no keys to configure.
 */
import { kill, run } from './lib.mjs';

const gateway = run('npm', ['run', 'dev', '-w', '@clause/gateway'], { env: { SETTLEMENT_MODE: process.env.SETTLEMENT_MODE ?? 'simulated' } });
const web = run('npm', ['run', 'dev', '-w', '@clause/web']);

console.log('\n  Clause dev → web http://localhost:5173 · gateway http://localhost:8787\n');
const stop = () => {
  kill(gateway);
  kill(web);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
gateway.on('exit', (c) => c && stop());
