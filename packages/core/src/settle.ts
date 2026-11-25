import type { AttestationData, VoucherData } from './eip712.js';
import { encodeInput, InputFields } from './input.js';

/** Build the 41-byte input exactly as ClauseEscrow._buildInput does (PRD §5 step 6). */
export function inputFieldsFor(v: VoucherData, a: Omit<AttestationData, 'sellerSig' | 'gatewaySig'>, grace: number): InputFields {
  return {
    responseHash: a.responseHash as `0x${string}`,
    sealedHash: v.sealedHash as `0x${string}`,
    arrival: a.arrival,
    deadline: v.deadline,
    grace,
    statusOK: a.statusOK ? 1 : 0,
    deliveredValue: a.deliveredValue,
    quotedValue: v.quotedValue,
    tolerance: v.tolerance,
  };
}

export function buildInput(v: VoucherData, a: Omit<AttestationData, 'sellerSig' | 'gatewaySig'>, grace: number): Uint8Array {
  return encodeInput(inputFieldsFor(v, a, grace));
}
