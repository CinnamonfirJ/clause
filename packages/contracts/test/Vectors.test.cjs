/**
 * "Local sim must equal on-chain eval for every one" (PRD §4).
 * Cross-checks the reference-model vectors (packages/core/vectors/vectors.json) against the
 * processor reached THROUGH ClauseEscrow.previewVerdict — i.e. the exact path settlement uses.
 *
 * Here the processor is the DEV MOCK. To run the same vectors against the partner's real
 * TapeOut processor, use scripts/verify-processor.cjs.
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { deployFixture } = require('./helpers.cjs');

const VECTORS = path.join(__dirname, '..', '..', 'core', 'vectors', 'vectors.json');

describe('rule vectors: reference model == processor eval (via escrow)', function () {
  it('all mandatory + randomized vectors agree', async function () {
    if (!fs.existsSync(VECTORS)) this.skip();
    const { vectors } = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    const { escrow } = await deployFixture();
    const mismatches = [];
    for (const v of vectors) {
      const serviceId = v.template === 'E' ? 1 : 2;
      const got = Number(await escrow.previewVerdict(serviceId, v.input));
      if (got !== v.expect) mismatches.push({ ...v, got });
    }
    console.log(`      checked ${vectors.length} vectors (${vectors.filter((v) => v.mandatory).length} mandatory) against DEV MOCK processor`);
    expect(mismatches, JSON.stringify(mismatches.slice(0, 3))).to.have.length(0);
  });

  it('previewVerdict rejects wrong input length', async () => {
    const { escrow } = await deployFixture();
    await expect(escrow.previewVerdict(1, '0x00')).to.be.revertedWithCustomError(escrow, 'BadInputLength');
  });
});
