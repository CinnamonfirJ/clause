import { TEMPLATES } from '@clause/core';
import { useApi, useConfig } from '../lib/hooks';
import type { Stats } from '../lib/api';
import { formatAmount, pct } from '../lib/format';
import { Stopwatch } from '../components';

const TRUST = [
  ['Circuit', 'the verdict', 'No — sealed, public, replayable'],
  ['Escrow', 'custody, routing', 'No — no owner, no admin path'],
  ['Seller signature', 'response hash + delivered value', 'No — gateway cannot forge'],
  ['Gateway', 'arrival time, statusOK', 'Yes — the one remaining gap. Roadmap: TLS attestation'],
  ['Buyer voucher', 'commitment terms', 'No — gateway cannot swap terms'],
];

export function Landing() {
  const cfg = useConfig().data;
  const stats = useApi<Stats & { mode: string }>('/v1/stats', { pollMs: 4000 });
  const s = stats.data;
  const dec = cfg?.token.decimals ?? 6;
  const sym = cfg?.token.symbol ?? '';

  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">§ Refunds for x402 machine payments · X Layer</div>
          <h1>
            An agent's money is gone <em>the instant it's sent.</em>
          </h1>
          <p className="lede">
            When an AI agent pays an API and the API dies, returns garbage, or answers late, nobody gives the money back. Clause holds each payment in
            escrow until a public, taped-out circuit decides: <b>delivered as promised → seller paid; not → buyer refunded.</b> No support ticket. No
            company in the loop.
          </p>
          <div className="cta">
            <a className="btn big" href="#/sandbox">
              Try it in 60 seconds →
            </a>
            <a className="btn big ghost" href="#/rules">
              Test the rule yourself
            </a>
          </div>
          <div style={{ marginTop: 14 }}>
            <Stopwatch /> <span className="tiny muted">· no wallet needed</span>
          </div>
        </div>
        <div className="receipt-art" aria-label="Example refund receipt">
          <div className="r"><span>call</span><span>0x9f3c…a1e2</span></div>
          <div className="r"><span>service</span><span>FX live rate · Template B</span></div>
          <div className="r"><span>quoted</span><span>EURUSD 1.08320 ± 5 bps</span></div>
          <div className="r"><span>seller</span><span>connection dropped</span></div>
          <div className="r"><span>statusOK</span><span>0</span></div>
          <div className="r"><span>circuit verdict</span><span>0</span></div>
          <div className="r"><span>human action</span><span>none</span></div>
          <div className="stamp">REFUNDED</div>
        </div>
      </section>

      <section aria-label="Live stats">
        <div className="spread" style={{ marginBottom: 10 }}>
          <span className="eyebrow" style={{ margin: 0 }}>Live from the gateway</span>
          {cfg && <span className="tiny muted">{cfg.verdictSource}</span>}
        </div>
        <div className="stats">
          <div className="stat">
            <div className="k">Calls adjudicated</div>
            <div className="v">{s ? (s.paid + s.refunded).toLocaleString() : '—'}</div>
          </div>
          <div className="stat">
            <div className="k">Refunds landed</div>
            <div className="v" style={{ color: 'var(--refund)' }}>{s ? s.refunded.toLocaleString() : '—'}</div>
          </div>
          <div className="stat">
            <div className="k">Refunded</div>
            <div className="v">{s ? `${formatAmount(s.refundVolume, dec, 2)}` : '—'} <span className="small muted">{sym}</span></div>
          </div>
          <div className="stat">
            <div className="k">Refund rate</div>
            <div className="v">{s ? pct(s.refundRate) : '—'}</div>
          </div>
        </div>
        {stats.error && <p className="small muted" style={{ marginTop: 8 }}>Stats unavailable: {stats.error.message}</p>}
      </section>

      <section className="section">
        <h2>How a call is judged</h2>
        <div className="how">
          <div>
            <span className="section-mark">§1</span>
            <h3>The quote is sealed</h3>
            <p>The gateway answers 402 with the seller's exact quoted bytes in plaintext and their hash. The agent reads the value before it signs.</p>
          </div>
          <div>
            <span className="section-mark">§2</span>
            <h3>The buyer signs the terms</h3>
            <p>An EIP-712 voucher commits hash, value, tolerance and deadline. The gateway can't change them afterwards.</p>
          </div>
          <div>
            <span className="section-mark">§3</span>
            <h3>The seller signs the delivery</h3>
            <p>The seller signs the hash and value of what it actually sent. The gateway stamps arrival time and status.</p>
          </div>
          <div>
            <span className="section-mark">§4</span>
            <h3>The circuit decides</h3>
            <p>41 bytes go into an immutable TapeOut circuit. 1 pays the seller. 0 refunds the buyer. Anyone can replay it.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Two rule templates</h2>
        <div className="template-cards">
          {(['E', 'B'] as const).map((t) => (
            <div key={t} className="card card-pad">
              <div className="spread">
                <span className="mono" style={{ fontWeight: 700 }}>
                  Template {t} — {TEMPLATES[t].name}
                </span>
                <span className="tiny muted">{TEMPLATES[t].gateBudget}</span>
              </div>
              <p className="mono small" style={{ marginTop: 10 }}>{TEMPLATES[t].rule}</p>
              <p className="small muted" style={{ marginTop: 8 }}>{TEMPLATES[t].useCase}</p>
              {cfg && (
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  circuit ID <span className="mono">{cfg.circuits[t].circuitId}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Trust boundary</h2>
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Trusted for</th>
                <th>Can cheat?</th>
              </tr>
            </thead>
            <tbody>
              {TRUST.map(([c, t, x]) => (
                <tr key={c}>
                  <td><b>{c}</b></td>
                  <td>{t}</td>
                  <td style={x.startsWith('Yes') ? { color: 'var(--refund)' } : undefined}>{x}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="quote-claim">The contract routes on the chip's output; it holds no rules of its own.</p>
      </section>

      <section className="section">
        <h2>Honest about x402</h2>
        <div className="notice">
          Clause uses the standard x402 flow (402 → signed payload → response) with an <code>exact</code>-shaped payment requirement and a{' '}
          <code>clause</code> extension. Settlement is deferred to batch adjudication by the escrow, so this is a disclosed deviation, not a claim of full
          x402 spec compliance.
        </div>
      </section>
    </>
  );
}
