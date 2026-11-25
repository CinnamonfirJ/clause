/**
 * Chain mode against a LOCAL hardhat node:
 *   hardhat node :8545 → deploy ClauseEscrow + DEV MOCK processor/token → gateway (chain) :8787 → web :5173
 * Uses Hardhat's public test keys (see scripts/lib.mjs). The processor is a DEV MOCK, not a taped-out circuit.
 */
import { join } from 'node:path';
import { HARDHAT_KEYS, ROOT, kill, run, runToEnd, startHardhatNode, waitForOutput } from './lib.mjs';

const PORT = 8545;
const node = startHardhatNode(PORT);
let gateway;
let web;
const stop = () => {
  kill(web);
  kill(gateway);
  kill(node);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await waitForOutput(node, /Started HTTP and WebSocket JSON-RPC server/);
await runToEnd('npx', ['hardhat', 'run', 'scripts/deploy.cjs', '--network', 'localhost'], { cwd: join(ROOT, 'packages/contracts') });
gateway = run('npm', ['run', 'start', '-w', '@clause/gateway'], {
  env: {
    SETTLEMENT_MODE: 'chain',
    DEPLOYMENT_FILE: 'packages/contracts/deployments/localhost.json',
    RPC_URL: `http://127.0.0.1:${PORT}`,
    GATEWAY_PRIVATE_KEY: HARDHAT_KEYS.gateway,
    SELLER_PRIVATE_KEY: HARDHAT_KEYS.seller,
    DEMO_FUNDER_PRIVATE_KEY: HARDHAT_KEYS.funder,
    DB_PATH: 'packages/gateway/data/clause-localchain.db',
  },
});
web = run('npm', ['run', 'dev', '-w', '@clause/web']);
console.log('\n  Clause (local chain) → web http://localhost:5173 · gateway http://localhost:8787 · rpc :8545\n');
