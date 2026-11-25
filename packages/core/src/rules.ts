/**
 * REFERENCE MODEL of the two rule templates (PRD §4).
 *
 * This is NOT the taped-out circuit. The gate-level netlists, their tape-out on
 * X Layer and the processor that evaluates them are partner-owned (TapeOut / "Tape X").
 * This model encodes the rule *as written in the PRD* so that:
 *   - the gateway can preview verdicts and explain them,
 *   - the rule tester can flip verdicts live without a wallet,
 *   - the partner's netlist simulator / on-chain eval can be cross-checked against it
 *     (see packages/core/vectors and packages/contracts/scripts/verify-processor.cjs).
 *
 * Any disagreement between this model and the real circuit is a bug to be resolved
 * jointly — the circuit is authoritative for on-chain verdicts.
 */
import { decodeInput, InputFields, INPUT_LENGTH } from './input.js';

export type TemplateId = 'E' | 'B';
export type Verdict = 0 | 1;

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  rule: string;
  useCase: string;
  gateBudget: string;
  /** Byte ranges the template ignores (inclusive start, exclusive end). */
  ignored: [number, number];
}

export const TEMPLATES: Record<TemplateId, TemplateInfo> = {
  E: {
    id: 'E',
    name: 'Exact',
    rule: 'statusOK AND hashMatch AND arrival ≤ deadline + grace',
    useCase: 'Files, fixed lookups, sealed quotes',
    gateBudget: '~800 NAND',
    ignored: [29, 41],
  },
  B: {
    id: 'B',
    name: 'Band',
    rule: 'statusOK AND |delivered − quoted| ≤ tolerance AND arrival ≤ deadline + grace',
    useCase: 'Live rates / feeds where small drift is acceptable',
    gateBudget: '~1,350 NAND',
    ignored: [0, 16],
  },
};

/**
 * [UNRESOLVED — agree with partner] How the circuit reads the 1-byte statusOK field.
 * Encoders in this codebase only ever write 0x00 or 0x01, so this only matters for
 * hand-edited bytes in the rule tester. Reference model: strictly 0x01 means OK.
 */
export function statusOkFromByte(b: number): boolean {
  return b === 1;
}

export interface Clause {
  key: 'statusOK' | 'hashMatch' | 'onTime' | 'withinBand';
  label: string;
  pass: boolean;
  detail: string;
}

export interface Evaluation {
  template: TemplateId;
  verdict: Verdict;
  clauses: Clause[];
  fields: InputFields;
}

export function evaluate(template: TemplateId, input: Uint8Array | InputFields): Evaluation {
  const f = input instanceof Uint8Array ? decodeInput(input) : input;
  if (input instanceof Uint8Array && input.length !== INPUT_LENGTH) throw new RangeError('bad input length');

  const statusOK = statusOkFromByte(f.statusOK);
  // deadline + grace is computed without uint32 overflow (33-bit in gates).
  const limit = f.deadline + f.grace;
  const onTime = f.arrival <= limit;

  const clauses: Clause[] = [
    {
      key: 'statusOK',
      label: 'Upstream answered OK',
      pass: statusOK,
      detail: `statusOK byte = 0x${f.statusOK.toString(16).padStart(2, '0')}`,
    },
  ];

  if (template === 'E') {
    const hashMatch = f.responseHash.toLowerCase() === f.sealedHash.toLowerCase();
    clauses.push({
      key: 'hashMatch',
      label: 'Delivered bytes match sealed quote',
      pass: hashMatch,
      detail: `${f.responseHash} ${hashMatch ? '==' : '≠'} ${f.sealedHash}`,
    });
  } else {
    const diff = Math.abs(f.deliveredValue - f.quotedValue);
    clauses.push({
      key: 'withinBand',
      label: 'Delivered value within tolerance',
      pass: diff <= f.tolerance,
      detail: `|${f.deliveredValue} − ${f.quotedValue}| = ${diff} ${diff <= f.tolerance ? '≤' : '>'} ${f.tolerance}`,
    });
  }

  clauses.push({
    key: 'onTime',
    label: 'Arrived before deadline + grace',
    pass: onTime,
    detail: `${f.arrival} ${onTime ? '≤' : '>'} ${f.deadline} + ${f.grace} = ${limit}`,
  });

  const verdict: Verdict = clauses.every((c) => c.pass) ? 1 : 0;
  return { template, verdict, clauses, fields: f };
}

export function verdictOf(template: TemplateId, input: Uint8Array | InputFields): Verdict {
  return evaluate(template, input).verdict;
}

/** Tolerance is an absolute uint32 computed off-chain from bps (PRD §4: no multiplier in gates). */
export function toleranceFromBps(quotedValue: number, bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('bps must be 0..10000');
  return Math.floor((quotedValue * bps) / 10_000);
}

/** A pluggable verdict engine. Reference model today; partner's netlist sim / on-chain eval later. */
export interface RuleEngine {
  readonly id: string;
  readonly kind: 'reference-model' | 'netlist-sim' | 'onchain';
  evaluate(template: TemplateId, circuitId: string, input: Uint8Array): Promise<Verdict>;
}

export const referenceEngine: RuleEngine = {
  id: 'clause-reference-model',
  kind: 'reference-model',
  async evaluate(template, _circuitId, input) {
    return verdictOf(template, input);
  },
};
