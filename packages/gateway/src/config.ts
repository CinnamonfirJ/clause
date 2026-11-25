import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const GATEWAY_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(GATEWAY_ROOT, '..', '..');

/** Minimal .env loader (no dependency). Real environment variables win. */
export function loadDotEnv(file = join(REPO_ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, k, raw] = m;
    if (process.env[k] !== undefined) continue;
    process.env[k] = raw.replace(/^["']|["']$/g, '');
  }
}

export type SettlementMode = 'simulated' | 'chain';

export interface CircuitConfig {
  circuitId: string;
  processor: string;
  /** Link to the taped-out circuit (partner-provided). Empty until tape-out. */
  tapeoutUrl: string;
  /** configured = real TapeOut values supplied; dev-mock = local MockRuleProcessor; reference-model = simulated mode. */
  status: 'configured' | 'dev-mock' | 'reference-model' | 'pending-partner';
}

export interface Config {
  port: number;
  publicUrl: string;
  webUrl: string;
  mode: SettlementMode;
  dbPath: string;
  gatewayPrivateKey?: string;
  crankPrivateKey?: string;
  chainId: number;
  rpcUrl: string;
  escrowAddress: string;
  token: { address: string; symbol: string; decimals: number };
  explorerUrl: string;
  circuits: { E: CircuitConfig; B: CircuitConfig };
  demo: {
    sellerEmbedded: boolean;
    sellerPort: number;
    sellerAdminPort: number;
    sellerUrl: string;
    sellerAdminUrl: string;
    sellerPrivateKey?: string;
    sellerPayee?: string;
    funderPrivateKey?: string;
    fundAmount: bigint;
    servicePrice: bigint;
    serviceGrace: number;
    serviceSla: number;
    toleranceBps: number;
    deploymentServices?: { fxSealed?: string; fxLive?: string };
  };
  crankIntervalMs: number;
  voucherTtlSeconds: number;
  allowPrivateUpstreams: boolean;
  serveWebDist: boolean;
  crankToken?: string;
}

/** Simulated-mode sentinels. Clearly not real addresses. */
export const SIM_ESCROW = '0x00000000000000000000000000000000c1a05e00';
export const SIM_TOKEN = '0x00000000000000000000000000000000c1a05ed0';
export const SIM_PROCESSOR = '0x0000000000000000000000000000000000000000';

function num(v: string | undefined, d: number) {
  return v === undefined || v === '' ? d : Number(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.SETTLEMENT_MODE ?? 'simulated') as SettlementMode;
  if (mode !== 'simulated' && mode !== 'chain') throw new Error(`SETTLEMENT_MODE must be simulated|chain`);

  // Chain deployment file (written by packages/contracts/scripts/deploy.cjs)
  let dep: any = {};
  if (env.DEPLOYMENT_FILE) {
    const p = isAbsolute(env.DEPLOYMENT_FILE) ? env.DEPLOYMENT_FILE : join(REPO_ROOT, env.DEPLOYMENT_FILE);
    if (!existsSync(p)) throw new Error(`DEPLOYMENT_FILE not found: ${p}`);
    dep = JSON.parse(readFileSync(p, 'utf8'));
  }

  const port = num(env.PORT, 8787);
  const sellerPort = num(env.DEMO_SELLER_PORT, 4100);
  const sellerAdminPort = num(env.DEMO_SELLER_ADMIN_PORT, 4101);

  const circuitStatus = (id: string | undefined, processor: string | undefined): CircuitConfig['status'] => {
    if (mode === 'simulated') return 'reference-model';
    if (dep.processorIsDevMock) return 'dev-mock';
    return id && processor ? 'configured' : 'pending-partner';
  };
  const processor = env.PROCESSOR_ADDRESS ?? dep.processor ?? SIM_PROCESSOR;
  const cE = env.CIRCUIT_ID_E ?? dep.circuits?.E ?? '1';
  const cB = env.CIRCUIT_ID_B ?? dep.circuits?.B ?? '2';

  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    webUrl: (env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    mode,
    dbPath: env.DB_PATH ? (isAbsolute(env.DB_PATH) ? env.DB_PATH : join(REPO_ROOT, env.DB_PATH)) : join(GATEWAY_ROOT, 'data', `clause-${mode}.db`),
    gatewayPrivateKey: env.GATEWAY_PRIVATE_KEY || undefined,
    crankPrivateKey: env.CRANK_PRIVATE_KEY || env.GATEWAY_PRIVATE_KEY || undefined,
    chainId: num(env.CHAIN_ID, dep.chainId ?? 196),
    rpcUrl: env.RPC_URL ?? (dep.chainId === 31337 ? 'http://127.0.0.1:8545' : 'https://rpc.xlayer.tech'),
    escrowAddress: mode === 'simulated' ? SIM_ESCROW : env.ESCROW_ADDRESS ?? dep.escrow ?? '',
    token: {
      address: mode === 'simulated' ? SIM_TOKEN : env.TOKEN_ADDRESS ?? dep.token ?? '',
      symbol: env.TOKEN_SYMBOL ?? (mode === 'simulated' ? 'cdUSD' : dep.devMocks ? 'cdUSD' : 'USDT'),
      decimals: num(env.TOKEN_DECIMALS, 6),
    },
    explorerUrl: (env.EXPLORER_URL ?? (dep.chainId === 31337 ? '' : 'https://www.okx.com/web3/explorer/xlayer')).replace(/\/$/, ''),
    circuits: {
      E: { circuitId: cE, processor, tapeoutUrl: env.TAPEOUT_URL_E ?? '', status: circuitStatus(env.CIRCUIT_ID_E ?? dep.circuits?.E, processor) },
      B: { circuitId: cB, processor, tapeoutUrl: env.TAPEOUT_URL_B ?? '', status: circuitStatus(env.CIRCUIT_ID_B ?? dep.circuits?.B, processor) },
    },
    demo: {
      sellerEmbedded: (env.DEMO_SELLER_EMBEDDED ?? 'true') === 'true',
      sellerPort,
      sellerAdminPort,
      sellerUrl: (env.DEMO_SELLER_URL ?? `http://127.0.0.1:${sellerPort}`).replace(/\/$/, ''),
      sellerAdminUrl: (env.DEMO_SELLER_ADMIN_URL ?? `http://127.0.0.1:${sellerAdminPort}`).replace(/\/$/, ''),
      sellerPrivateKey: env.SELLER_PRIVATE_KEY || undefined,
      sellerPayee: env.SELLER_PAYEE ?? dep.payee,
      funderPrivateKey: env.DEMO_FUNDER_PRIVATE_KEY || undefined,
      fundAmount: BigInt(env.DEMO_FUND_AMOUNT ?? '1000000'), // 1.00 at 6 decimals
      servicePrice: BigInt(env.DEMO_PRICE ?? dep.price ?? '10000'), // 0.01
      serviceGrace: num(env.DEMO_GRACE, dep.grace ?? 5),
      serviceSla: num(env.DEMO_SLA_SECONDS, 3),
      toleranceBps: num(env.DEMO_TOLERANCE_BPS, 5),
      deploymentServices: dep.services ? { fxSealed: dep.services.fxSealed?.id, fxLive: dep.services.fxLive?.id } : undefined,
    },
    crankIntervalMs: num(env.CRANK_INTERVAL_MS, mode === 'simulated' ? 2000 : 4000),
    voucherTtlSeconds: Math.min(num(env.VOUCHER_TTL_SECONDS, 120), 600),
    allowPrivateUpstreams: (env.ALLOW_PRIVATE_UPSTREAMS ?? (env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
    serveWebDist: (env.SERVE_WEB_DIST ?? 'true') === 'true',
    crankToken: env.CRANK_TOKEN || undefined,
  };
}
