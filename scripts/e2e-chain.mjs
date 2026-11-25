/**
 * Chain-mode end-to-end test: hardhat node → deploy ClauseEscrow (+ DEV MOCK processor/token)
 * → gateway in chain mode → paid calls + kill switch → verify on-chain balances/status.
 */
import { join } from 'node:path';
import { HARDHAT_KEYS, ROOT, kill, runToEnd, startHardhatNode, waitForOutput } from './lib.mjs';

const PORT = Number(process.env.E2E_RPC_PORT ?? 8546);
const rpc = `http://127.0.0.1:${PORT}`;
const node = startHardhatNode(PORT);
try {
  await waitForOutput(node, /Started HTTP and WebSocket JSON-RPC server/);
  console.log(`hardhat node up on ${rpc}`);
  await runToEnd('npx', ['hardhat', 'run', 'scripts/deploy.cjs', '--network', 'localhost'], {
    cwd: join(ROOT, 'packages/contracts'),
    env: { LOCAL_RPC_URL: rpc },
  });
  await runToEnd('node', ['--import', 'tsx', '--test', 'test/chain.e2e.ts'], {
    cwd: join(ROOT, 'packages/gateway'),
    env: {
      DEPLOYMENT_FILE: 'packages/contracts/deployments/localhost.json',
      RPC_URL: rpc,
      GATEWAY_PRIVATE_KEY: HARDHAT_KEYS.gateway,
      SELLER_PRIVATE_KEY: HARDHAT_KEYS.seller,
      DEMO_FUNDER_PRIVATE_KEY: HARDHAT_KEYS.funder,
    },
  });
  console.log('chain e2e passed');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  kill(node);
}
