/**
 * Test vectors for the rule templates (PRD §4 "Mandatory test vectors").
 * "Local sim must equal on-chain eval for every one."
 *
 * These vectors are generated from the reference model and are used to:
 *   - unit-test the reference model (packages/core/test),
 *   - cross-check the dev-mock processor (packages/contracts/test),
 *   - cross-check the partner's real TapeOut processor (packages/contracts/scripts/verify-processor.cjs).
 */
import { bytesToHex, encodeInput, InputFields, UINT32_MAX } from './input.js';
import { TemplateId, verdictOf } from './rules.js';

export interface TestVector {
  name: string;
  template: TemplateId;
  input: `0x${string}`;
  expect: 0 | 1;
  mandatory: boolean;
}

const H1 = '0x1122334455667788' as const;
const H1_FLIP = '0x1122334455667789' as const; // differs by exactly 1 bit (LSB)

function base(overrides: Partial<InputFields> = {}): InputFields {
  return {
    responseHash: H1,
    sealedHash: H1,
    arrival: 1_764_000_000,
    deadline: 1_764_000_010,
    grace: 5,
    statusOK: 1,
    deliveredValue: 108_320,
    quotedValue: 108_320,
    tolerance: 50,
    ...overrides,
  };
}

function v(name: string, template: TemplateId, f: InputFields, expect: 0 | 1): TestVector {
  const input = bytesToHex(encodeInput(f));
  return { name, template, input, expect, mandatory: true };
}

export function mandatoryVectors(): TestVector[] {
  const dl = 1_764_000_010;
  const g = 5;
  return [
    v('E: hash match, arrival == deadline + grace', 'E', base({ arrival: dl + g }), 1),
    v('E: hash match, arrival == deadline + grace + 1', 'E', base({ arrival: dl + g + 1 }), 0),
    v('E: hash differs by 1 bit, in time', 'E', base({ responseHash: H1_FLIP }), 0),
    v('E: hash match, in time, statusOK = 0', 'E', base({ statusOK: 0 }), 0),
    v('B: delivered == quoted', 'B', base({ deliveredValue: 108_320, quotedValue: 108_320 }), 1),
    v('B: |diff| == tolerance', 'B', base({ deliveredValue: 108_370, quotedValue: 108_320, tolerance: 50 }), 1),
    v('B: |diff| == tolerance + 1', 'B', base({ deliveredValue: 108_371, quotedValue: 108_320, tolerance: 50 }), 0),
    v('B: delivered < quoted, within tolerance', 'B', base({ deliveredValue: 108_280, quotedValue: 108_320, tolerance: 50 }), 1),
  ];
}

/** Deterministic PRNG (mulberry32) so vector sets are reproducible across machines. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Randomized vectors biased toward boundaries (equal hashes, |diff| near tolerance,
 * arrival near deadline+grace, uint32 extremes) so both verdicts are well represented.
 */
export function randomVectors(count: number, seed = 0xc1a05e): TestVector[] {
  const r = prng(seed);
  const u32 = () => Math.floor(r() * (UINT32_MAX + 1));
  const small = (n: number) => Math.floor(r() * n);
  const hex8 = () => {
    let s = '0x';
    for (let i = 0; i < 8; i++) s += small(256).toString(16).padStart(2, '0');
    return s as `0x${string}`;
  };
  const out: TestVector[] = [];
  for (let i = 0; i < count; i++) {
    const template: TemplateId = r() < 0.5 ? 'E' : 'B';
    const sealed = hex8();
    const hashMode = r();
    const responseHash = hashMode < 0.6 ? sealed : hashMode < 0.8 ? flipBit(sealed, small(64)) : hex8();

    const extreme = r() < 0.1;
    const deadline = extreme ? UINT32_MAX - small(10) : u32();
    const grace = extreme ? small(20) : small(3600);
    const limit = deadline + grace;
    const tm = r();
    let arrival = tm < 0.4 ? limit - small(100) : tm < 0.6 ? limit : tm < 0.8 ? limit + 1 + small(100) : u32();
    arrival = Math.max(0, Math.min(UINT32_MAX, arrival));

    const quotedValue = u32();
    const tolerance = r() < 0.1 ? u32() : small(100_000);
    const dm = r();
    let delta = dm < 0.4 ? small(tolerance + 1) : dm < 0.6 ? tolerance : dm < 0.8 ? tolerance + 1 + small(1000) : small(UINT32_MAX);
    if (r() < 0.5) delta = -delta;
    const deliveredValue = Math.max(0, Math.min(UINT32_MAX, quotedValue + delta));

    const statusOK = r() < 0.85 ? 1 : r() < 0.5 ? 0 : small(256);
    const f: InputFields = { responseHash, sealedHash: sealed, arrival, deadline, grace, statusOK, deliveredValue, quotedValue, tolerance };
    const input = bytesToHex(encodeInput(f));
    out.push({ name: `random #${i}`, template, input, expect: verdictOf(template, f), mandatory: false });
  }
  return out;
}

function flipBit(hex: `0x${string}`, bit: number): `0x${string}` {
  const n = BigInt(hex) ^ (1n << BigInt(bit));
  return ('0x' + n.toString(16).padStart(16, '0')) as `0x${string}`;
}
