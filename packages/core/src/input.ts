/**
 * The unified 41-byte circuit input (PRD §4).
 *
 * [VERIFY — partner-owned] The PRD marks this layout "confirm against real eval ABI".
 * This module is the single place that knows the byte layout; if the TapeOut
 * processor ABI differs, change it here (and in ClauseEscrow._buildInput).
 *
 * All multi-byte integers are big-endian (assumption, matches abi.encodePacked).
 */

export const INPUT_LENGTH = 41;

export type Hex8 = `0x${string}`; // 8 bytes = 16 hex chars

export interface InputFields {
  /** SHA-256 of the raw delivered body, first 8 bytes. Source: seller-signed attestation. */
  responseHash: Hex8;
  /** SHA-256 of the quoted bytes, first 8 bytes. Source: buyer voucher. */
  sealedHash: Hex8;
  /** uint32 unix seconds. Source: gateway attestation. */
  arrival: number;
  /** uint32 unix seconds. Source: buyer voucher. */
  deadline: number;
  /** uint32 seconds. Source: service registration (immutable). */
  grace: number;
  /** 1 byte. Source: gateway attestation. */
  statusOK: number;
  /** uint32 fixed-point. Source: seller-signed attestation. */
  deliveredValue: number;
  /** uint32 fixed-point. Source: buyer voucher. */
  quotedValue: number;
  /** uint32 absolute tolerance. Source: buyer voucher. */
  tolerance: number;
}

export type FieldName = keyof InputFields;

export interface FieldSpec {
  name: FieldName;
  offset: number;
  size: number;
  kind: 'hash' | 'uint32' | 'byte';
  label: string;
  source: 'seller attestation' | 'buyer voucher' | 'gateway attestation' | 'service registration';
}

export const FIELD_LAYOUT: readonly FieldSpec[] = [
  { name: 'responseHash', offset: 0, size: 8, kind: 'hash', label: 'Response hash', source: 'seller attestation' },
  { name: 'sealedHash', offset: 8, size: 8, kind: 'hash', label: 'Sealed hash', source: 'buyer voucher' },
  { name: 'arrival', offset: 16, size: 4, kind: 'uint32', label: 'Arrival', source: 'gateway attestation' },
  { name: 'deadline', offset: 20, size: 4, kind: 'uint32', label: 'Deadline', source: 'buyer voucher' },
  { name: 'grace', offset: 24, size: 4, kind: 'uint32', label: 'Grace', source: 'service registration' },
  { name: 'statusOK', offset: 28, size: 1, kind: 'byte', label: 'Status OK', source: 'gateway attestation' },
  { name: 'deliveredValue', offset: 29, size: 4, kind: 'uint32', label: 'Delivered value', source: 'seller attestation' },
  { name: 'quotedValue', offset: 33, size: 4, kind: 'uint32', label: 'Quoted value', source: 'buyer voucher' },
  { name: 'tolerance', offset: 37, size: 4, kind: 'uint32', label: 'Tolerance', source: 'buyer voucher' },
] as const;

export const UINT32_MAX = 0xffffffff;

function assertUint32(name: string, v: number) {
  if (!Number.isInteger(v) || v < 0 || v > UINT32_MAX) {
    throw new RangeError(`${name} must be a uint32, got ${v}`);
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

export function encodeInput(f: InputFields): Uint8Array {
  const out = new Uint8Array(INPUT_LENGTH);
  const dv = new DataView(out.buffer);
  for (const spec of FIELD_LAYOUT) {
    const v = f[spec.name];
    if (spec.kind === 'hash') {
      const b = hexToBytes(v as string);
      if (b.length !== 8) throw new RangeError(`${spec.name} must be 8 bytes`);
      out.set(b, spec.offset);
    } else if (spec.kind === 'uint32') {
      assertUint32(spec.name, v as number);
      dv.setUint32(spec.offset, v as number, false);
    } else {
      const n = v as number;
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`${spec.name} must be a byte`);
      out[spec.offset] = n;
    }
  }
  return out;
}

export function decodeInput(bytes: Uint8Array): InputFields {
  if (bytes.length !== INPUT_LENGTH) throw new RangeError(`input must be ${INPUT_LENGTH} bytes, got ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hash = (o: number) => bytesToHex(bytes.slice(o, o + 8)) as Hex8;
  return {
    responseHash: hash(0),
    sealedHash: hash(8),
    arrival: dv.getUint32(16, false),
    deadline: dv.getUint32(20, false),
    grace: dv.getUint32(24, false),
    statusOK: bytes[28],
    deliveredValue: dv.getUint32(29, false),
    quotedValue: dv.getUint32(33, false),
    tolerance: dv.getUint32(37, false),
  };
}

export function fieldForOffset(offset: number): FieldSpec | undefined {
  return FIELD_LAYOUT.find((f) => offset >= f.offset && offset < f.offset + f.size);
}
