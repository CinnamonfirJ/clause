/**
 * Batch crank (PRD §6 "POST /internal/crank — batch settle; anyone may call chain directly").
 *
 * Each tick:
 *   1. settleBatch() every attested call whose voucher has not expired (≤ BATCH per tx)
 *   2. timeout reclaim: any unresolved call whose voucher expired → reclaim() (refund state)
 *
 * Zero human action: a killed seller produces a statusOK=0 attestation at request time,
 * and the next tick settles it → verdict 0 → refund.
 */
import { nowSec, type Store } from './db.js';
import { TERMINAL_SKIPS, type Settlement } from './settlement/types.js';

const BATCH = 25;
const MAX_ATTEMPTS = 5;

export interface CrankSummary {
  at: number;
  settled: number;
  paid: number;
  refunded: number;
  skipped: number;
  reclaimed: number;
  errors: string[];
  txHashes: string[];
}

export class Crank {
  private timer?: NodeJS.Timeout;
  private busy: Promise<CrankSummary> | null = null;
  last: CrankSummary | null = null;
  totalTicks = 0;

  constructor(
    private readonly store: Store,
    private readonly settlement: Settlement,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(intervalMs: number) {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`crank error: ${e?.message ?? e}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Concurrent callers share the in-progress tick instead of double-submitting. */
  tick(): Promise<CrankSummary> {
    if (!this.busy) {
      this.busy = this.run().finally(() => {
        this.busy = null;
      });
    }
    return this.busy;
  }

  private async run(): Promise<CrankSummary> {
    const s: CrankSummary = { at: nowSec(), settled: 0, paid: 0, refunded: 0, skipped: 0, reclaimed: 0, errors: [], txHashes: [] };
    this.totalTicks++;

    // 1. settle
    const due = this.store.callsToSettle(BATCH, nowSec() + 2);
    if (due.length) {
      const items = due.map((call) => ({ call, service: this.store.getService(call.serviceId)! }));
      try {
        const outcomes = await this.settlement.settleBatch(items);
        for (const o of outcomes) {
          if (o.txHash && !s.txHashes.includes(o.txHash)) s.txHashes.push(o.txHash);
          if (o.kind === 'settled') {
            this.store.markSettled(o.callId, o.verdict === 1 ? 'paid' : 'refunded', o.verdict, o.inputHex, o.txHash);
            s.settled++;
            o.verdict === 1 ? s.paid++ : s.refunded++;
          } else {
            const call = due.find((c) => c.callId === o.callId)!;
            const terminal = TERMINAL_SKIPS.has(o.reason) || call.settleAttempts + 1 >= MAX_ATTEMPTS;
            this.store.markSkipped(o.callId, o.reason, terminal);
            s.skipped++;
            this.log(`skip ${o.callId.slice(0, 10)}… ${o.reason}${terminal ? ' (terminal → reclaim after expiry)' : ''}`);
          }
        }
      } catch (e: any) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        s.errors.push(`settleBatch: ${msg}`);
        for (const c of due) this.store.bumpAttempt(c.callId, `tx-failed: ${msg.slice(0, 120)}`);
      }
    }

    // 2. timeout reclaim
    for (const call of this.store.callsToReclaim(nowSec(), BATCH)) {
      const service = this.store.getService(call.serviceId)!;
      try {
        const r = await this.settlement.reclaim(call, service);
        if (r.ok) {
          this.store.markReclaimed(call.callId, r.txHash);
          s.reclaimed++;
          if (r.txHash) s.txHashes.push(r.txHash);
        } else if (r.alreadyResolved) {
          // Settled elsewhere (e.g. someone called the chain directly). Sync terminal state.
          const st = r.alreadyResolved.status;
          if (st === 3) this.store.markReclaimed(call.callId, null);
          else if (st === 1 || st === 2) this.store.markSettled(call.callId, st === 1 ? 'paid' : 'refunded', st === 1 ? 1 : 0, call.inputHex ?? '', call.settleTx);
        } else {
          s.errors.push(`reclaim ${call.callId.slice(0, 10)}…: ${r.error}`);
        }
      } catch (e: any) {
        s.errors.push(`reclaim ${call.callId.slice(0, 10)}…: ${e?.message ?? e}`);
      }
    }

    if (s.settled || s.reclaimed || s.errors.length) {
      this.log(`crank: ${s.paid} paid · ${s.refunded} refunded · ${s.reclaimed} reclaimed · ${s.skipped} skipped${s.errors.length ? ` · ${s.errors.length} errors` : ''}`);
    }
    this.store.pruneQuotes(nowSec() - 24 * 3600);
    this.last = s;
    return s;
  }
}
