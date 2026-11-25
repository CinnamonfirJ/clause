/**
 * Partner cross-check tool: run the reference-model vectors against a processor's eval().
 * "Local sim must equal on-chain eval for every one" (PRD §4).
 *
 *   # self-test against the DEV MOCK (in-process hardhat network):
 *   npx hardhat run scripts/verify-processor.cjs
 *
 *   # against the partner's real TapeOut processor (read-only eth_call, no gas):
 *   PROCESSOR_ADDRESS=0x… CIRCUIT_ID_E=… CIRCUIT_ID_B=… npx hardhat run scripts/verify-processor.cjs --network xlayer
 *
 * Optional: LIMIT=1000 to run a subset; ESCROW_ADDRESS=0x… to go through ClauseEscrow.previewVerdict
 * (SERVICE_ID_E / SERVICE_ID_B) instead of calling the processor directly.
 *
 * [VERIFY] Assumes eval(uint256,bytes) returns a uint8-compatible word. If the real ABI differs,
 * adapt PROCESSOR_ABI below AND ClauseEscrow._eval.
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { ethers } = hre;

const PROCESSOR_ABI = ['function eval(uint256 circuitId, bytes input) view returns (uint8)'];
const VECTORS = path.join(__dirname, '..', '..', 'core', 'vectors', 'vectors.json');

async function main() {
  if (!fs.existsSync(VECTORS)) throw new Error('vectors.json missing — run `npm run vectors` at the repo root');
  let { vectors } = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  if (process.env.LIMIT) vectors = vectors.slice(0, Number(process.env.LIMIT));

  let call;
  let label;
  if (process.env.ESCROW_ADDRESS) {
    const escrow = new ethers.Contract(process.env.ESCROW_ADDRESS, ['function previewVerdict(uint256,bytes) view returns (uint8)'], ethers.provider);
    const ids = { E: process.env.SERVICE_ID_E, B: process.env.SERVICE_ID_B };
    call = (v) => escrow.previewVerdict(ids[v.template], v.input);
    label = `ClauseEscrow.previewVerdict @ ${process.env.ESCROW_ADDRESS}`;
  } else {
    let address = process.env.PROCESSOR_ADDRESS;
    let circuits = { E: process.env.CIRCUIT_ID_E, B: process.env.CIRCUIT_ID_B };
    if (!address) {
      const mock = await (await ethers.getContractFactory('MockRuleProcessor')).deploy();
      address = await mock.getAddress();
      circuits = { E: '1', B: '2' };
      label = `DEV MOCK processor (self-test) @ ${address}`;
    } else {
      label = `processor @ ${address} on ${hre.network.name}`;
    }
    const proc = new ethers.Contract(address, PROCESSOR_ABI, ethers.provider);
    call = (v) => proc.eval(circuits[v.template], v.input);
  }

  console.log(`checking ${vectors.length} vectors against ${label}`);
  const mismatches = [];
  const errors = [];
  let gasSamples = { E: [], B: [] };
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    try {
      const got = Number(await call(v));
      if (got !== v.expect) mismatches.push({ name: v.name, template: v.template, input: v.input, expect: v.expect, got });
    } catch (e) {
      errors.push({ name: v.name, error: String(e.shortMessage || e.message) });
    }
    if (process.env.PROCESSOR_ADDRESS && i < 20) {
      try {
        const proc = new ethers.Contract(process.env.PROCESSOR_ADDRESS, PROCESSOR_ABI, ethers.provider);
        const g = await proc.eval.estimateGas(v.template === 'E' ? process.env.CIRCUIT_ID_E : process.env.CIRCUIT_ID_B, v.input);
        gasSamples[v.template].push(Number(g));
      } catch {
        /* estimateGas on a view may be unsupported */
      }
    }
    if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${vectors.length}`);
  }
  for (const t of ['E', 'B']) {
    if (gasSamples[t].length) console.log(`  eval gas (estimate) template ${t}: ~${Math.round(gasSamples[t].reduce((a, b) => a + b, 0) / gasSamples[t].length)}`);
  }
  console.log(`mismatches: ${mismatches.length} · errors: ${errors.length}`);
  if (mismatches.length) console.log(JSON.stringify(mismatches.slice(0, 10), null, 2));
  if (errors.length) console.log(JSON.stringify(errors.slice(0, 5), null, 2));
  if (mismatches.length || errors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
