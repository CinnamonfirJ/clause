import { sha256 } from 'ethers';
import { hexToBytes } from './input.js';

/**
 * responseHash / sealedHash: SHA-256 of the exact raw bytes, first 8 bytes (PRD §4).
 * Never canonicalize JSON — hash the bytes exactly as committed / delivered.
 */
export function hash8(raw: Uint8Array): `0x${string}` {
  return sha256(raw).slice(0, 18) as `0x${string}`;
}

export const ZERO_HASH8 = '0x0000000000000000' as const;

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes32(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

export { hexToBytes };
