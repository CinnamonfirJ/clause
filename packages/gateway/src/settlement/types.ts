import type { TypedDataDomain } from 'ethers';
import type { CallRow, ServiceRow } from '../db.js';

export interface SettleItem {
  call: CallRow;
  service: ServiceRow;
}

export type SettleOutcome =
  | { callId: string; kind: 'settled'; verdict: 0 | 1; inputHex: string; txHash: string | null }
  | { callId: string; kind: 'skipped'; reason: string; txHash: string | null };

export interface ReclaimResult {
  ok: boolean;
  txHash: string | null;
  error?: string;
  /** The call already has a terminal on-chain status (e.g. settled by someone else). */
  alreadyResolved?: { status: number };
}

/**
 * Where funds live and who produces the verdict.
 * - SimulatedSettlement: SQLite ledger mirroring ClauseEscrow + Clause reference model. Wallet-free, no chain.
 * - ChainSettlement: the deployed ClauseEscrow; verdicts come from its configured processor
 *   (partner's TapeOut processor on X Layer, or the DEV MOCK on a local hardhat node).
 */
export interface Settlement {
  readonly mode: 'simulated' | 'chain';
  /** Human-readable description of what produces verdicts. */
  readonly verdictSource: string;
  domain(): TypedDataDomain;
  balanceOf(account: string, token: string): Promise<bigint>;
  pendingWithdrawal(account: string, token: string): Promise<{ amount: bigint; requestedAt: number }>;
  settleBatch(items: SettleItem[]): Promise<SettleOutcome[]>;
  reclaim(call: CallRow, service: ServiceRow): Promise<ReclaimResult>;
  preview(service: ServiceRow, input: Uint8Array): Promise<0 | 1>;
  /** Demo faucet: credit `account` with demo funds in the escrow. */
  fund(account: string, amount: bigint): Promise<{ txHash: string | null }>;
  callStatus(callId: string): Promise<number>;
  txUrl(hash: string | null): string | null;
}

/** Skip reasons that will never succeed on retry. */
export const TERMINAL_SKIPS = new Set([
  'bad-voucher-sig',
  'bad-seller-sig',
  'bad-gateway-sig',
  'call-already-resolved',
  'voucher-expired',
  'max-amount-below-price',
  'issued-after-withdraw-request',
  'unknown-service',
  'callid-mismatch',
  'bad-failure-attestation',
  'voucher-lifetime-too-long',
]);
