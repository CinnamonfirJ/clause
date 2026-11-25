import { Wallet, Contract, getAddress } from 'ethers';
import { CLAUSE_ESCROW_ABI, sameAddress, type TemplateId } from '@clause/core';
import type { Config } from './config.js';
import { SIM_PROCESSOR } from './config.js';
import { nowSec, Store, type ServiceRow } from './db.js';
import { Gateway } from './gateway.js';
import { Crank } from './crank.js';
import { SimulatedSettlement } from './settlement/simulated.js';
import { ChainSettlement } from './settlement/chain.js';
import type { Settlement } from './settlement/types.js';
import { DemoSeller } from './demo-seller/seller.js';

export interface AppContext {
  cfg: Config;
  store: Store;
  settlement: Settlement;
  gateway: Gateway;
  crank: Crank;
  seller?: DemoSeller;
  attester: Wallet;
  demoServiceIds: { fxSealed?: string; fxLive?: string };
  log: (msg: string) => void;
  close(): Promise<void>;
}

/** Simulated mode only: generate and persist local dev keys so the demo runs with zero setup. */
function devKey(store: Store, name: string): string {
  const k = `dev.${name}`;
  let v = store.getKv(k);
  if (!v) {
    v = Wallet.createRandom().privateKey;
    store.setKv(k, v);
  }
  return v;
}

const DEMO_META = {
  fxSealed: {
    name: 'FX sealed quote',
    template: 'E' as TemplateId,
    path: '/sealed',
    toleranceBps: 0,
    description: 'You get exactly the bytes you were quoted, on time — or the circuit refunds you.',
  },
  fxLive: {
    name: 'FX live rate',
    template: 'B' as TemplateId,
    path: '/live',
    toleranceBps: 5,
    description: 'A live rate within ±5 bps of the quote, on time — or the circuit refunds you.',
  },
};

export async function createContext(cfg: Config, log: (m: string) => void = console.log): Promise<AppContext> {
  const store = new Store(cfg.dbPath);
  const sim = cfg.mode === 'simulated';

  const gatewayKey = cfg.gatewayPrivateKey ?? (sim ? devKey(store, 'gatewayKey') : undefined);
  if (!gatewayKey) throw new Error('GATEWAY_PRIVATE_KEY is required in chain mode');
  const attester = new Wallet(gatewayKey);

  let settlement: Settlement;
  if (sim) {
    const treasury = new Wallet(devKey(store, 'treasuryKey')).address;
    settlement = new SimulatedSettlement(store, { chainId: cfg.chainId, escrow: cfg.escrowAddress, treasury, token: cfg.token.address });
  } else {
    if (!cfg.escrowAddress || !cfg.token.address) throw new Error('ESCROW_ADDRESS and TOKEN_ADDRESS (or DEPLOYMENT_FILE) are required in chain mode');
    const verdictSource =
      cfg.circuits.E.status === 'dev-mock'
        ? 'ClauseEscrow → MockRuleProcessor (DEV MOCK on a local chain — not a taped-out circuit)'
        : 'ClauseEscrow → TapeOut processor (on-chain circuit eval)';
    const chain = new ChainSettlement({
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      escrow: cfg.escrowAddress,
      token: cfg.token.address,
      crankKey: cfg.crankPrivateKey ?? gatewayKey,
      funderKey: cfg.demo.funderPrivateKey,
      explorerUrl: cfg.explorerUrl,
      verdictSource,
    });
    await chain.assertReady();
    settlement = chain;
  }

  // Demo seller (embedded) — a real HTTP server on its own port.
  const sellerKey = cfg.demo.sellerPrivateKey ?? (sim ? devKey(store, 'sellerKey') : undefined);
  let seller: DemoSeller | undefined;
  if (cfg.demo.sellerEmbedded) {
    if (!sellerKey) throw new Error('SELLER_PRIVATE_KEY is required to embed the demo seller in chain mode');
    seller = new DemoSeller({
      port: cfg.demo.sellerPort,
      adminPort: cfg.demo.sellerAdminPort,
      signerKey: sellerKey,
      chainId: cfg.chainId,
      escrow: cfg.escrowAddress,
      autoReviveMs: Number(process.env.DEMO_SELLER_AUTO_REVIVE_MS ?? 120_000),
    });
    await seller.start();
    log(`demo FX seller ${seller.address} listening on :${cfg.demo.sellerPort} (admin :${cfg.demo.sellerAdminPort})`);
  }
  const sellerAddress = sellerKey ? new Wallet(sellerKey).address : undefined;

  // Services
  const demoServiceIds: AppContext['demoServiceIds'] = {};
  if (sim) {
    for (const key of ['fxSealed', 'fxLive'] as const) {
      let id = store.getKv(`demo.${key}`);
      if (!id || !store.getService(id)) {
        const meta = DEMO_META[key];
        id = store.nextSimServiceId();
        const row: ServiceRow = {
          id,
          name: meta.name,
          template: meta.template,
          circuitId: cfg.circuits[meta.template].circuitId,
          processor: SIM_PROCESSOR,
          payee: new Wallet(devKey(store, 'payeeKey')).address,
          signer: sellerAddress!,
          gateway: attester.address,
          token: cfg.token.address,
          price: cfg.demo.servicePrice.toString(),
          grace: cfg.demo.serviceGrace,
          feeBps: 100,
          toleranceBps: meta.toleranceBps,
          slaSeconds: cfg.demo.serviceSla,
          valueDecimals: 5,
          upstreamUrl: cfg.demo.sellerUrl + meta.path,
          description: meta.description,
          source: 'demo',
          registerTx: null,
          createdAt: nowSec(),
        };
        store.insertService(row);
        store.setKv(`demo.${key}`, id);
      }
      demoServiceIds[key] = id;
    }
  } else if (cfg.demo.deploymentServices) {
    const escrow = new Contract(cfg.escrowAddress, CLAUSE_ESCROW_ABI as unknown as string[], (settlement as ChainSettlement).provider);
    for (const key of ['fxSealed', 'fxLive'] as const) {
      const id = cfg.demo.deploymentServices[key];
      if (!id) continue;
      demoServiceIds[key] = id;
      if (store.getService(id)) continue;
      const s = await escrow.getService(BigInt(id));
      const meta = DEMO_META[key];
      const template: TemplateId = s.circuitId.toString() === cfg.circuits.B.circuitId ? 'B' : 'E';
      if (!sameAddress(s.gateway, attester.address)) log(`WARNING: service ${id} gateway ${s.gateway} ≠ this gateway's attester ${attester.address}; settlement will skip`);
      if (sellerAddress && !sameAddress(s.signer, sellerAddress)) log(`WARNING: service ${id} signer ${s.signer} ≠ demo seller ${sellerAddress}`);
      store.insertService({
        id,
        name: meta.name,
        template,
        circuitId: s.circuitId.toString(),
        processor: getAddress(s.processor),
        payee: getAddress(s.payee),
        signer: getAddress(s.signer),
        gateway: getAddress(s.gateway),
        token: getAddress(s.token),
        price: s.price.toString(),
        grace: Number(s.grace),
        feeBps: Number(s.feeBps),
        toleranceBps: template === 'B' ? cfg.demo.toleranceBps : 0,
        slaSeconds: cfg.demo.serviceSla,
        valueDecimals: 5,
        upstreamUrl: cfg.demo.sellerUrl + meta.path,
        description: meta.description,
        source: 'demo',
        registerTx: null,
        createdAt: nowSec(),
      });
    }
  }

  const gateway = new Gateway(cfg, store, settlement, attester);
  const crank = new Crank(store, settlement, log);

  return {
    cfg,
    store,
    settlement,
    gateway,
    crank,
    seller,
    attester,
    demoServiceIds,
    log,
    async close() {
      crank.stop();
      await seller?.stop();
      store.close();
    },
  };
}
