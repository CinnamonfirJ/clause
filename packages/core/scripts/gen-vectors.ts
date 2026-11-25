/**
 * Writes vectors/vectors.json: the 8 mandatory PRD vectors + 10,000 randomized vectors.
 * Consumed by the contracts test suite and by scripts/verify-processor.cjs (partner cross-check).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mandatoryVectors, randomVectors } from '../src/vectors.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'vectors', 'vectors.json');
const count = Number(process.argv[2] ?? 10_000);
const vectors = [...mandatoryVectors(), ...randomVectors(count)];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      generatedBy: 'packages/core/scripts/gen-vectors.ts (reference model)',
      layout: '41-byte unified input, PRD §4',
      count: vectors.length,
      vectors,
    },
    null,
    0,
  ),
);
const ones = vectors.filter((v) => v.expect === 1).length;
console.log(`wrote ${vectors.length} vectors (${ones} pay / ${vectors.length - ones} refund) → ${out}`);
