import { useEffect, useState } from 'react';
import { hexToBytes } from '@clause/core';
import { useApi } from '../lib/hooks';
import { GATEWAY, type Receipt, type SigCheck } from '../lib/api';
import { formatAmount, short, time } from '../lib/format';
import { href } from '../lib/router';
import { ByteGrid, ByteLegend, CircuitChip, ClauseList, CopyButton, ErrorBox, FieldTable, Loading, Section, StatePill } from '../components';

const FAIL_PHRASE: Record<string, string> = {
  statusOK: 'statusOK = 0',
  hashMatch: 'delivered bytes ≠ sealed quote',
  withinBand: 'value outside tolerance',
  onTime: 'arrived after deadline + grace',
};

function headline(r: Receipt) {
  const failed = r.evaluation?.clauses.find((c) => !c.pass);
  const reason = failed ? { label: FAIL_PHRASE[failed.key] ?? failed.label } : undefined;
  if (r.outcome === 'paid') return { cls: 'pay', big: '1', title: 'Paid: the seller delivered as promised', sub: 'Every clause held, so the circuit returned 1 and the escrow paid the seller.' };
  if (r.outcome === 'refunded')
    return {
      cls: 'refund',
      big: '0',
      title: 'Refunded: the circuit returned 0',
      sub: r.delivery.failureReason
        ? `${capitalize(r.delivery.failureReason)} → ${reason?.label ?? 'a clause failed'} → the buyer was refunded.`
        : `${capitalize(reason?.label ?? 'a clause failed')} → the buyer was refunded.`,
    };
  if (r.outcome === 'reclaimed') return { cls: 'refund', big: '↩', title: 'Reclaimed after timeout', sub: 'The voucher expired before anyone settled it, so the call was finalized as refunded. The buyer was never charged.' };
  if (r.outcome === 'stuck') return { cls: 'pending', big: '…', title: 'Could not settle, so it will be reclaimed', sub: `Settlement skipped (${r.skipReason}). Once the voucher expires, the crank finalizes the call as refunded.` };
  return { cls: 'pending', big: '…', title: 'Settling', sub: `Delivery is attested. The crank submits it to the escrow within seconds. Expected verdict: ${r.expectedVerdict ?? '—'}.` };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Sig({ label, s }: { label: string; s: SigCheck | null }) {
  if (!s) return null;
  return (
    <tr>
      <td>{label}</td>
      <td className="addr">{s.signer ?? '—'}</td>
      <td className="addr">{s.expected}</td>
      <td>{s.valid === null ? <span className="pill neutral" title={s.note}>n/a</span> : s.valid ? <span className="pill pay">✓ valid</span> : <span className="pill refund">✗ invalid</span>}</td>
    </tr>
  );
}

export function ReceiptPage({ callId }: { callId: string }) {
  const valid = /^0x[0-9a-fA-F]{64}$/.test(callId);
  const [pollMs, setPollMs] = useState<number | undefined>(1500);
  const r = useApi<Receipt>(valid ? `/v1/receipts/${callId}` : null, { pollMs });
  const [hot, setHot] = useState<string | null>(null);
  const data = r.data;
  const final = !!data && ['paid', 'refunded', 'reclaimed'].includes(data.outcome);
  useEffect(() => {
    if (final) setPollMs(undefined);
  }, [final]);

  if (!valid) return <div className="notice err">That isn't a valid call ID (expected 32-byte hex).</div>;
  if (r.loading && !data) return <Loading lines={6} />;
  if (r.error && !data) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!data) return null;

  const h = headline(data);
  const dec = data.token.decimals;
  const bytes = data.input ? hexToBytes(data.input.hex) : null;

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="eyebrow">§ Receipt · {data.mode === 'simulated' ? 'simulated mode' : 'on-chain'}</div>
          <h1 className="mono" style={{ fontSize: 'clamp(16px, 2.4vw, 22px)', wordBreak: 'break-all' }}>{data.callId}</h1>
        </div>
        <div className="row">
          <StatePill state={data.state} verdict={data.expectedVerdict} />
          <CopyButton text={data.callId} label="Copy call ID" />
        </div>
      </div>

      <div className={`verdict ${h.cls}`} role="status">
        <div className="big" aria-hidden>{h.big}</div>
        <div>
          <h2>{h.title}</h2>
          <p>{h.sub}</p>
        </div>
      </div>

      <div className="grid-2 even">
        <Section mark="§1" title="Settlement">
          <dl className="kv">
            <dt>Service</dt>
            <dd>
              {data.service.name} · Template {data.service.template}
            </dd>
            <dt>Amount</dt>
            <dd>
              {formatAmount(data.price, dec)} {data.token.symbol}
              {data.outcome === 'paid' && <span className="muted small"> · fee {data.service.feeBps / 100}% to treasury</span>}
            </dd>
            <dt>Buyer</dt>
            <dd className="addr">{data.buyer}</dd>
            <dt>Circuit ID</dt>
            <dd className="row">
              <span className="mono">{data.service.circuitId}</span>
              <CircuitChip status={data.service.circuitStatus} />
              {data.service.tapeoutUrl && (
                <a href={data.service.tapeoutUrl} target="_blank" rel="noreferrer" className="small">
                  tape-out ↗
                </a>
              )}
            </dd>
            <dt>Processor</dt>
            <dd className="addr">{data.mode === 'simulated' ? 'none (simulated)' : data.service.processor}</dd>
            <dt>Verdict</dt>
            <dd>
              {data.verdict ?? '—'} <span className="muted small">({data.verdictSource})</span>
            </dd>
            <dt>Transaction</dt>
            <dd>
              {data.tx ? (
                data.tx.url ? (
                  <a className="addr" href={data.tx.url} target="_blank" rel="noreferrer">
                    {short(data.tx.hash, 10, 8)} ↗
                  </a>
                ) : (
                  <span className="addr">{data.tx.hash}</span>
                )
              ) : data.mode === 'simulated' ? (
                <span className="muted">none: simulated ledger, no chain transaction</span>
              ) : (
                <span className="muted">not yet settled</span>
              )}
            </dd>
            <dt>Timeline</dt>
            <dd className="small">
              voucher {time(data.timestamps.created)} · attested {time(data.timestamps.attested)} · settled {time(data.timestamps.settled)}
            </dd>
          </dl>
        </Section>

        <Section mark="§2" title="Why this verdict" aside={<span className="tiny muted">{data.service.templateRule}</span>}>
          {data.evaluation ? <ClauseList clauses={data.evaluation.clauses} /> : <p className="muted">No delivery has been attested yet.</p>}
          {data.evaluation && (
            <p className="tiny muted" style={{ marginTop: 10 }}>
              Explanation from the Clause reference model of the rule.{' '}
              {data.verdict !== null && data.verdict !== data.evaluation.verdict && <b style={{ color: 'var(--refund)' }}>It disagrees with the settled verdict. Report this.</b>}
            </p>
          )}
        </Section>
      </div>

      {bytes && data.input && (
        <Section
          mark="§3"
          title="The 41 bytes the circuit saw"
          aside={
            <div className="row">
              <CopyButton text={data.input.hex} label="Copy hex" />
              <a className="btn sm" href={href('/rules', { service: data.service.id, input: data.input.hex })}>
                Replay in rule tester →
              </a>
            </div>
          }
        >
          <div className="stack">
            <ByteGrid bytes={bytes} template={data.service.template} hotField={hot} />
            <ByteLegend />
            <FieldTable fields={data.input.fields} template={data.service.template} valueDecimals={5} onHover={setHot} />
            <p className="tiny muted">
              Emitted on-chain as <span className="mono">Adjudicated(callId, circuitId, verdict, input)</span>. Anyone can feed these bytes to the circuit and
              check the verdict.
            </p>
          </div>
        </Section>
      )}

      <div className="grid-2 even">
        <Section mark="§4" title="What was quoted vs. delivered">
          <div className="stack">
            {data.quote && (
              <div>
                <div className="spread small">
                  <b>Plaintext quote (the buyer saw this before signing)</b>
                  {data.quote.check.ok ? <span className="pill pay">seal matches</span> : <span className="pill refund">seal mismatch</span>}
                </div>
                <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--paper-2)', padding: 10, borderRadius: 5, margin: '6px 0 0' }}>
                  {data.quote.plaintext}
                </pre>
                <p className="tiny muted" style={{ marginTop: 4 }}>sealedHash {data.quote.sealedHash}</p>
              </div>
            )}
            <div>
              <b className="small">Delivered</b>
              {data.delivery.body ? (
                <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--paper-2)', padding: 10, borderRadius: 5, margin: '6px 0 0' }}>
                  {data.delivery.body}
                </pre>
              ) : (
                <p className="small" style={{ marginTop: 6, color: 'var(--refund)' }}>
                  Nothing delivered: {data.delivery.failureReason ?? 'no response'}
                </p>
              )}
              {data.attestation && <p className="tiny muted" style={{ marginTop: 4 }}>responseHash {data.attestation.responseHash}</p>}
            </div>
          </div>
        </Section>

        <Section mark="§5" title="Signatures (recovered now, in your browser's gateway)">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Recovered</th>
                  <th>Registered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <Sig label="Buyer voucher" s={data.signatures.voucher} />
                <Sig label="Seller receipt" s={data.signatures.seller} />
                <Sig label="Gateway attestation" s={data.signatures.gateway} />
              </tbody>
            </table>
          </div>
          {data.signatures.seller?.note && <p className="tiny muted" style={{ marginTop: 8 }}>Seller: {data.signatures.seller.note}.</p>}
          <p className="tiny muted" style={{ marginTop: 8 }}>
            <a href={`${GATEWAY}/v1/receipts/${data.callId}`} target="_blank" rel="noreferrer">
              Raw receipt JSON ↗
            </a>
          </p>
        </Section>
      </div>
    </div>
  );
}
