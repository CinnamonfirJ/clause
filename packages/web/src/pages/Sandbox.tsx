import { useEffect, useMemo, useRef, useState } from 'react';
import { Wallet } from 'ethers';
import { ClauseClient, type ClauseExtension } from '@clause/core';
import { api, ApiError, GATEWAY, type Account, type CallSummary } from '../lib/api';
import { useApi, useConfig } from '../lib/hooks';
import { fixed, formatAmount, short } from '../lib/format';
import { load, save } from '../lib/storage';
import { href } from '../lib/router';
import { ErrorBox, StatePill, Stopwatch } from '../components';

type Phase = 'quoting' | 'signing' | 'delivered' | 'failed' | 'rejected';

interface Row {
  n: number;
  callId?: string;
  phase: Phase;
  quote?: ClauseExtension;
  status?: number;
  body?: string;
  failure?: string;
  expectedVerdict?: number;
}

type Fault = 'none' | 'late' | 'drift' | 'tamper' | 'error';

const FAULT_LABEL: Record<Fault, string> = {
  none: 'Healthy',
  late: 'Answers late (past deadline + grace)',
  drift: 'Drifts outside tolerance (Template B)',
  tamper: 'Sends different bytes than sealed (Template E)',
  error: 'Returns HTTP 503',
};

function loadAgent(): Wallet {
  const k = load('clause.agentKey');
  if (k) {
    try {
      return new Wallet(k);
    } catch {
      /* fall through */
    }
  }
  const w = Wallet.createRandom();
  save('clause.agentKey', w.privateKey);
  return new Wallet(w.privateKey);
}

function parseRate(text?: string): string | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j.rate ?? null;
  } catch {
    return null;
  }
}

export function Sandbox() {
  const cfg = useConfig().data;
  const [agent, setAgent] = useState<Wallet>(loadAgent);
  const session = useMemo(() => `sbx-${agent.address.slice(2, 12).toLowerCase()}`, [agent]);
  const account = useApi<Account>(`/v1/accounts/${agent.address}`, { pollMs: 2500 });
  const [serviceKey, setServiceKey] = useState<'fxLive' | 'fxSealed'>('fxLive');
  const [pair, setPair] = useState('EURUSD');
  const [autoKill, setAutoKill] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [killedAt, setKilledAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [killed, setKilled] = useState(false);
  const [fault, setFault] = useState<Fault>('none');
  const [landed, setLanded] = useState<Set<string>>(new Set());
  const prevStates = useRef(new Map<string, string>());

  const ids = rows.map((r) => r.callId).filter(Boolean) as string[];
  const unresolved = rows.some((r) => r.callId) && !ids.every((id) => ['paid', 'refunded', 'reclaimed'].includes(prevStates.current.get(id) ?? ''));
  const calls = useApi<{ calls: CallSummary[] }>(ids.length ? `/v1/calls?session=${session}&limit=100` : null, { pollMs: unresolved || running ? 1200 : undefined });
  const byId = useMemo(() => new Map((calls.data?.calls ?? []).map((c) => [c.callId, c])), [calls.data]);

  // Highlight refunds the moment they land.
  useEffect(() => {
    const fresh: string[] = [];
    for (const c of calls.data?.calls ?? []) {
      const before = prevStates.current.get(c.callId);
      if (before && before !== c.state && (c.state === 'refunded' || c.state === 'reclaimed')) fresh.push(c.callId);
      prevStates.current.set(c.callId, c.state);
    }
    if (fresh.length) setLanded((s) => new Set([...s, ...fresh]));
  }, [calls.data]);

  // Restore session-scoped seller state.
  useEffect(() => {
    api<{ sessionFault: string | null; running: boolean }>(`/demo/seller/status?session=${session}`)
      .then((s) => {
        setKilled(s.sessionFault === 'kill' || !s.running);
        if (s.sessionFault && s.sessionFault !== 'kill') setFault(s.sessionFault as Fault);
      })
      .catch(() => {});
  }, [session]);

  const dec = cfg?.token.decimals ?? 6;
  const sym = cfg?.token.symbol ?? '';
  const serviceId = cfg?.demo.services[serviceKey];
  const acct = account.data;
  const funded = acct ? BigInt(acct.available) > 0n : false;

  const clientOpts = useMemo(
    () => ({
      signer: agent,
      maxPrice: 1_000_000n,
      extraHeaders: { 'X-Clause-Demo-Session': session },
    }),
    [agent, session],
  );

  async function fund() {
    setBusy('fund');
    setError(null);
    try {
      await api('/demo/fund', { json: { address: agent.address } });
      account.reload();
    } catch (e: any) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function setSellerDead(dead: boolean) {
    setBusy('kill');
    try {
      await api(dead ? '/demo/seller/kill' : '/demo/seller/revive', { json: { session } });
      setKilled(dead);
      if (!dead) setFault('none');
    } catch (e: any) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function applyFault(f: Fault) {
    setFault(f);
    try {
      await api('/demo/seller/fault', { json: { session, fault: f } });
      setKilled(false);
    } catch (e: any) {
      setError(e);
    }
  }

  async function runCalls(count = 10) {
    if (!serviceId) return;
    setRunning(true);
    setError(null);
    setLanded(new Set());
    const startN = rows.length ? Math.max(...rows.map((r) => r.n)) : 0;
    const url = `${GATEWAY}/v1/call/${serviceId}?pair=${pair}`;
    try {
      for (let i = 1; i <= count; i++) {
        const n = startN + i;
        if (autoKill && i === 6 && !killed) {
          await setSellerDead(true);
          setKilledAt(n);
        }
        setRows((r) => [{ n, phase: 'quoting' }, ...r]);
        const update = (patch: Partial<Row>) => setRows((rs) => rs.map((x) => (x.n === n ? { ...x, ...patch } : x)));
        const local = new ClauseClient({
          ...clientOpts,
          onEvent: (e) => {
            if (e.type === 'quote') update({ quote: e.quote, callId: e.quote.callId, phase: 'signing' });
            if (e.type === 'rejected') update({ phase: 'rejected', failure: e.reason });
          },
        });
        try {
          const res = await local.fetch(url);
          if (res.payment) {
            update({
              callId: res.payment.callId,
              phase: res.status === 200 ? 'delivered' : 'failed',
              status: res.status,
              body: res.text,
              failure: res.payment.failureReason,
              expectedVerdict: res.payment.expectedVerdict,
            });
          } else {
            let msg = res.error ?? res.text;
            try {
              msg = JSON.parse(res.text).error ?? msg;
            } catch {
              /* keep */
            }
            update({ phase: 'rejected', status: res.status, failure: msg || `HTTP ${res.status}` });
            if (res.status === 402 && /insufficient/.test(msg)) break;
          }
        } catch (e: any) {
          update({ phase: 'rejected', failure: e?.message ?? 'network error' });
        }
        account.reload();
      }
    } finally {
      setRunning(false);
      calls.reload();
    }
  }

  function newAgent() {
    const w = Wallet.createRandom();
    save('clause.agentKey', w.privateKey);
    setAgent(new Wallet(w.privateKey));
    setRows([]);
    setKilledAt(null);
    setKilled(false);
    setFault('none');
    prevStates.current.clear();
  }

  const merged = rows.map((r) => ({ ...r, server: r.callId ? byId.get(r.callId) : undefined }));
  const paid = merged.filter((r) => r.server?.state === 'paid').length;
  const refunded = merged.filter((r) => r.server?.state === 'refunded' || r.server?.state === 'reclaimed').length;
  const pending = merged.filter((r) => r.callId && r.server && !['paid', 'refunded', 'reclaimed'].includes(r.server.state)).length;
  const firstRefund = [...merged].reverse().find((r) => r.server?.state === 'refunded' || r.server?.state === 'reclaimed');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§ Sandbox · {cfg?.mode === 'chain' ? `chain ${cfg.chainId}` : 'simulated mode, no wallet'}</div>
          <h1>Kill the seller. Watch the refund land.</h1>
          <p className="lede">
            A real x402 agent runs in your browser with a throwaway key. It pays for live FX rates, signing a voucher for each call. Halfway through,
            the seller's API dies. Nobody touches anything, and the circuit refunds every failed call.
          </p>
        </div>
        <Stopwatch />
      </div>

      <ErrorBox error={error} />

      <div className="grid-2" style={{ marginTop: error ? 16 : 0 }}>
        <div className="stack">
          <section className="card card-pad">
            <ol className="steps">
              <li className={funded ? 'done' : ''}>
                <div className="spread">
                  <b>Deposit</b>
                  {acct && (
                    <span className="mono small">
                      {formatAmount(acct.balance, dec)} {sym}
                    </span>
                  )}
                </div>
                <p className="small muted" style={{ margin: '4px 0 10px' }}>
                  Demo agent <span className="addr">{short(agent.address)}</span>. Its key lives only in this browser.
                </p>
                <button className="btn block" onClick={fund} disabled={busy === 'fund' || (acct ? BigInt(acct.balance) >= BigInt(cfg?.demo.fundAmount ?? '0') * 3n : false)}>
                  {busy === 'fund' ? 'Depositing…' : `${funded ? 'Top up' : 'Deposit'} ${formatAmount(cfg?.demo.fundAmount ?? '1000000', dec, 2)} ${sym} into escrow`}
                </button>
                {acct && BigInt(acct.reserved) > 0n && (
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    {formatAmount(acct.reserved, dec)} reserved for calls awaiting the circuit's verdict
                  </p>
                )}
              </li>
              <li className={rows.length ? 'done' : ''}>
                <b>Call a paid API</b>
                <div className="field-grid" style={{ marginTop: 10 }}>
                  <label className="field">
                    <span>Service</span>
                    <select value={serviceKey} onChange={(e) => setServiceKey(e.target.value as any)} disabled={running}>
                      <option value="fxLive">Live rate (B)</option>
                      <option value="fxSealed">Sealed quote (E)</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Pair</span>
                    <select value={pair} onChange={(e) => setPair(e.target.value)} disabled={running}>
                      {['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF'].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="toggle" style={{ marginTop: 12 }}>
                  <input type="checkbox" checked={autoKill} onChange={(e) => setAutoKill(e.target.checked)} disabled={running} />
                  Kill the seller automatically at call 6
                </label>
                <button className="btn big block" style={{ marginTop: 12 }} onClick={() => runCalls(10)} disabled={!funded || running || !serviceId}>
                  {running ? 'Agent is calling…' : 'Run 10 paid calls'}
                </button>
                {!funded && acct && <p className="tiny muted" style={{ marginTop: 6 }}>Deposit first: the gateway checks the escrow balance before serving.</p>}
              </li>
              <li className={killed ? 'done' : ''}>
                <b>Kill switch</b>
                <div className={`kill ${killed ? 'dead' : ''}`} style={{ marginTop: 10 }}>
                  <div className="spread">
                    <span className="small">
                      Seller API: <b style={{ color: killed ? 'var(--refund)' : 'var(--pay)' }}>{killed ? 'DEAD' : fault !== 'none' ? 'MISBEHAVING' : 'UP'}</b>
                    </span>
                    <button className={`btn sm ${killed ? 'ghost' : 'danger'}`} onClick={() => setSellerDead(!killed)} disabled={busy === 'kill'}>
                      {killed ? 'Revive seller' : 'Kill seller API'}
                    </button>
                  </div>
                  <label className="field">
                    <span className="tiny">Or make it misbehave</span>
                    <select value={fault} onChange={(e) => applyFault(e.target.value as Fault)} disabled={running}>
                      {(Object.keys(FAULT_LABEL) as Fault[]).map((f) => (
                        <option key={f} value={f}>
                          {FAULT_LABEL[f]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="tiny muted">Scoped to your demo session, so other visitors' sellers stay up.</p>
                </div>
              </li>
            </ol>
          </section>
          <div className="row">
            <button className="btn sm ghost" onClick={newAgent} disabled={running}>
              New demo agent
            </button>
            <a className="btn sm ghost" href="#/rules">
              Rule tester
            </a>
          </div>
        </div>

        <section className="card" aria-live="polite">
          <div className="card-head">
            <h2>
              <span className="section-mark">§</span>Call ledger
            </h2>
            <div className="row small">
              <span className="pill pay">{paid} paid</span>
              <span className="pill refund">{refunded} refunded</span>
              {pending > 0 && (
                <span className="pill pending">
                  <span className="dot pulse" /> {pending} settling
                </span>
              )}
            </div>
          </div>

          {firstRefund && !running && (
            <div className="card-pad" style={{ borderBottom: '1px solid var(--rule)', background: 'var(--refund-bg)' }}>
              <div className="spread">
                <div>
                  <b style={{ color: 'var(--refund)' }}>Refund landed with zero human action.</b>
                  <p className="small" style={{ marginTop: 2 }}>
                    {refunded} × {formatAmount(cfg ? merged.find((m) => m.quote)?.quote?.price ?? '0' : '0', dec)} {sym} back in the agent's escrow
                    balance.
                    {firstRefund.server?.settleTxUrl && (
                      <>
                        {' '}
                        <a href={firstRefund.server.settleTxUrl} target="_blank" rel="noreferrer">
                          Explorer tx ↗
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <div className="row">
                  <a className="btn sm" href={href(`/receipt/${firstRefund.callId}`)}>
                    Open refund receipt →
                  </a>
                  <a className="btn sm ghost" href={href('/rules', { callId: firstRefund.callId, service: firstRefund.server?.serviceId })}>
                    Test the rule
                  </a>
                </div>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="empty">
              <p>No calls yet.</p>
              <p className="small" style={{ marginTop: 6 }}>
                Deposit, then run 10 paid calls. Each one shows the quote the agent approved, what the seller delivered, and the verdict.
              </p>
            </div>
          ) : (
            <ul className="ledger">
              {merged.map((r) => {
                const rate = parseRate(r.body);
                const quoted = r.quote ? fixed(r.quote.quotedValue, r.quote.valueDecimals) : null;
                const s = r.server;
                return (
                  <FragmentRow key={r.n} killedHere={killedAt === r.n}>
                    <li className={r.callId && landed.has(r.callId) ? 'landed' : ''}>
                      <span className="n">#{r.n}</span>
                      <div className="what">
                        <div className="line1">
                          {quoted ? `quote ${quoted}` : 'requesting quote…'}
                          {r.phase === 'signing' && ' → signing voucher…'}
                          {r.status === 200 && ` → 200 ${rate ?? ''}`}
                          {r.status && r.status !== 200 && ` → ${r.status}`}
                        </div>
                        <div className="line2">
                          {r.failure
                            ? r.failure
                            : r.phase === 'delivered'
                              ? r.expectedVerdict === 0
                                ? 'delivered, but outside the rule → circuit will refund'
                                : 'delivered within the rule'
                              : r.callId
                                ? short(r.callId, 8, 6)
                                : ' '}
                        </div>
                      </div>
                      <div className="row">
                        {s ? <StatePill state={s.state} verdict={s.expectedVerdict} /> : r.phase === 'rejected' ? <span className="pill neutral">Not charged</span> : <span className="pill pending"><span className="dot pulse" /> {r.phase}</span>}
                        {r.callId && s && (
                          <a className="small" href={href(`/receipt/${r.callId}`)} aria-label={`Receipt for call ${r.n}`}>
                            Receipt
                          </a>
                        )}
                      </div>
                    </li>
                  </FragmentRow>
                );
              })}
            </ul>
          )}
          {rows.length > 0 && (
            <div className="card-pad tiny muted" style={{ borderTop: '1px solid var(--rule)' }}>
              The crank settles every {Math.round((cfg?.crankIntervalMs ?? 2000) / 1000)}s. Verdicts:{' '}
              {cfg?.verdictSource ?? '…'}.
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function FragmentRow({ killedHere, children }: { killedHere: boolean; children: React.ReactNode }) {
  return (
    <>
      {children}
      {killedHere && <li className="killed-marker">✖ seller API killed here</li>}
    </>
  );
}
