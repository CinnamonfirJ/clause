import { useEffect, useState, type ReactNode } from 'react';
import { FIELD_LAYOUT, TEMPLATES, type Clause, type FieldSpec, type InputFields, type TemplateId } from '@clause/core';
import type { CircuitStatus } from './lib/api';
import { load, save } from './lib/storage';

export const SOURCE_CLASS: Record<FieldSpec['source'], string> = {
  'buyer voucher': 'voucher',
  'seller attestation': 'seller',
  'gateway attestation': 'gateway',
  'service registration': 'registry',
};

export function StatePill({ state, verdict }: { state: string; verdict?: number | null }) {
  if (state === 'paid') return <span className="pill pay">● Paid</span>;
  if (state === 'refunded') return <span className="pill refund">↩ Refunded</span>;
  if (state === 'reclaimed') return <span className="pill refund">↩ Reclaimed</span>;
  if (state === 'skipped' || state === 'stuck') return <span className="pill neutral">Awaiting reclaim</span>;
  if (state === 'in_flight') return <span className="pill pending"><span className="dot pulse" /> In flight</span>;
  if (state === 'attested') return <span className="pill pending"><span className="dot pulse" /> Settling{verdict === 0 ? ' → refund' : ''}</span>;
  return <span className="pill neutral">{state}</span>;
}

export function CircuitChip({ status }: { status: CircuitStatus }) {
  const map: Record<CircuitStatus, [string, string, string]> = {
    configured: ['pay', 'Taped-out circuit', 'Verdicts come from the TapeOut processor on X Layer.'],
    'dev-mock': ['pending', 'Dev mock processor', 'Local chain with a behavioural mock — not the taped-out circuit.'],
    'reference-model': ['neutral', 'Reference model · simulated', 'Simulated mode: verdicts come from the Clause reference model of the PRD rule, not a taped-out circuit.'],
    'pending-partner': ['pending', 'Awaiting tape-out', 'Circuit ID / processor not yet supplied by the TapeOut integration.'],
  };
  const [cls, label, title] = map[status];
  return (
    <span className={`pill ${cls}`} title={title}>
      {label}
    </span>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack-sm" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: { message: string; status?: number } | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice err row" role="alert">
      <span style={{ flex: 1 }}>{error.message}</span>
      {onRetry && (
        <button className="btn sm ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className = 'btn sm ghost' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          window.prompt('Copy:', text);
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Snippet({ code }: { code: string }) {
  return (
    <div className="snippet">
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} className="btn sm" />
    </div>
  );
}

export function ByteLegend() {
  return (
    <div className="legend" aria-label="Byte source legend">
      <span><i style={{ background: 'var(--f-voucher)' }} />buyer voucher</span>
      <span><i style={{ background: 'var(--f-seller)' }} />seller attestation</span>
      <span><i style={{ background: 'var(--f-gateway)' }} />gateway attestation</span>
      <span><i style={{ background: 'var(--f-registry)' }} />service registration</span>
    </div>
  );
}

/** The 41-byte unified input, coloured by which party committed each byte. */
export function ByteGrid({
  bytes,
  template,
  hotField,
  editable,
  onEdit,
  changed,
}: {
  bytes: Uint8Array;
  template?: TemplateId;
  hotField?: string | null;
  editable?: boolean;
  onEdit?: (offset: number, value: number) => void;
  changed?: Set<number>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const ignored = template ? TEMPLATES[template].ignored : null;
  return (
    <div className="bytes" role="group" aria-label="41-byte circuit input">
      {Array.from(bytes, (b, i) => {
        const f = FIELD_LAYOUT.find((x) => i >= x.offset && i < x.offset + x.size)!;
        const ign = ignored && i >= ignored[0] && i < ignored[1];
        const cls = `byte ${SOURCE_CLASS[f.source]}${ign ? ' ignored' : ''}${hotField === f.name ? ' hot' : ''}${changed?.has(i) ? ' changed' : ''}`;
        const hex = b.toString(16).padStart(2, '0');
        const title = `byte ${i} · ${f.label} (${f.source})${ign ? ' · ignored by this template' : ''}`;
        if (editable && editing === i) {
          return (
            <input
              key={i}
              className="byte-edit"
              autoFocus
              maxLength={2}
              value={draft}
              aria-label={`Edit byte ${i}`}
              onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-fA-F]/g, ''))}
              onBlur={() => {
                if (draft.length) onEdit?.(i, parseInt(draft, 16));
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          );
        }
        return editable ? (
          <button key={i} className={cls} title={title} onClick={() => { setEditing(i); setDraft(hex); }} aria-label={`${title}, value ${hex}. Click to edit`}>
            {hex}
            <span className="off">{i}</span>
          </button>
        ) : (
          <div key={i} className={cls} title={title}>
            {hex}
            <span className="off">{i}</span>
          </div>
        );
      })}
    </div>
  );
}

export function fieldDisplay(f: FieldSpec, fields: InputFields, valueDecimals?: number): string {
  const v = fields[f.name];
  if (f.kind === 'hash') return String(v);
  if (f.name === 'statusOK') return `${v} (${v === 1 ? 'OK' : 'not OK'})`;
  if ((f.name === 'arrival' || f.name === 'deadline') && typeof v === 'number' && v > 1_000_000_000) {
    return `${v} · ${new Date(v * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
  if (f.name === 'grace') return `${v} s`;
  if (valueDecimals && (f.name === 'deliveredValue' || f.name === 'quotedValue' || f.name === 'tolerance')) {
    return `${v} (${((v as number) / 10 ** valueDecimals).toFixed(valueDecimals)})`;
  }
  return String(v);
}

export function FieldTable({ fields, template, valueDecimals, onHover }: { fields: InputFields; template?: TemplateId; valueDecimals?: number; onHover?: (name: string | null) => void }) {
  const ignored = template ? TEMPLATES[template].ignored : null;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Bytes</th>
            <th>Field</th>
            <th>Value</th>
            <th>Committed by</th>
          </tr>
        </thead>
        <tbody>
          {FIELD_LAYOUT.map((f) => {
            const ign = ignored && f.offset >= ignored[0] && f.offset < ignored[1];
            return (
              <tr key={f.name} style={ign ? { opacity: 0.45 } : undefined} onMouseEnter={() => onHover?.(f.name)} onMouseLeave={() => onHover?.(null)}>
                <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>{f.offset}–{f.offset + f.size - 1}</td>
                <td>
                  {f.label}
                  {ign && <span className="tiny muted"> · ignored by {template}</span>}
                </td>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{fieldDisplay(f, fields, valueDecimals)}</td>
                <td><span className={`src ${SOURCE_CLASS[f.source]}`}>{f.source}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ClauseList({ clauses }: { clauses: Clause[] }) {
  return (
    <ul className="clauses">
      {clauses.map((c) => (
        <li key={c.key}>
          <span className={`mark ${c.pass ? 'ok' : 'no'}`} aria-label={c.pass ? 'passes' : 'fails'}>{c.pass ? '✓' : '✗'}</span>
          <div>
            <div>{c.label}</div>
            <div className="detail">{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Section({ mark, title, aside, children }: { mark?: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {mark && <span className="section-mark">{mark}</span>}
          {title}
        </h2>
        {aside}
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

/** Seconds since the visitor first landed (PRD acceptance: judge path in < 60 s). */
export function Stopwatch() {
  const [start] = useState(() => {
    const s = Number(load('clause.arrivedAt', 'session'));
    if (s) return s;
    const now = Date.now();
    save('clause.arrivedAt', String(now), 'session');
    return now;
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - start) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (
    <span className="stopwatch" title="Time since you arrived — the whole judge path is designed to take under a minute">
      <b>{mm}:{ss}</b> since you arrived
    </span>
  );
}
