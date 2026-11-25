/**
 * Run the demo FX seller as its own process (instead of embedded in the gateway).
 *   SELLER_PRIVATE_KEY=0x… CHAIN_ID=196 ESCROW_ADDRESS=0x… npm run seller -w @clause/gateway
 */
import { loadDotEnv } from '../config.js';
import { DemoSeller } from './seller.js';

loadDotEnv();
const key = process.env.SELLER_PRIVATE_KEY;
if (!key) throw new Error('SELLER_PRIVATE_KEY is required');
const seller = new DemoSeller({
  port: Number(process.env.DEMO_SELLER_PORT ?? 4100),
  adminPort: Number(process.env.DEMO_SELLER_ADMIN_PORT ?? 4101),
  host: process.env.DEMO_SELLER_HOST ?? '127.0.0.1',
  signerKey: key,
  chainId: Number(process.env.CHAIN_ID ?? 196),
  escrow: process.env.ESCROW_ADDRESS ?? '',
  autoReviveMs: Number(process.env.DEMO_SELLER_AUTO_REVIVE_MS ?? 120_000),
});
await seller.start();
console.log(`demo FX seller ${seller.address} — api :${seller.o.port}, admin :${seller.o.adminPort}`);
