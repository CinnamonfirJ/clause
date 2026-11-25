import { useMemo, useState } from 'react';
import { BrowserProvider, Contract, isAddress } from 'ethers';
import { CLAUSE_ESCROW_ABI, TEMPLATES, toleranceFromBps, type TemplateId } from '@clause/core';
import { api, ApiError, GATEWAY, type Service } from '../lib/api';
import { useApi, useConfig } from '../lib/hooks';
import { fixed, formatAmount, parseAmount, pct, short } from '../lib/format';
import { href } from '../lib/router';
import { CircuitChip, ErrorBox, Loading, Snippet } from '../components';

interface Form {
  template: TemplateId;
  name: string;
  upstreamUrl: string;
  price: string;
  grace: string;
  slaSeconds: string;
  toleranceBps: string;
  valueDecimals: string;
  payee: string;
  signer: string;
  description: string;
}

const EMPTY: Form = {
  template: 'B',
  name: '',
  upstreamUrl: '',
  price: '0.01',
  grace: '5',
  slaSeconds: '10',
  toleranceBps: '10',
  valueDecimals: '5',
  payee: '',
  signer: '',
  description: '',
};

function origin() {
  return GATEWAY || window.location.origin;
}

function webBase() {
  return window.location.origin + window.location.pathname;
}

export function SellerConsole() {
  const cfg = useConfig().data;
  const services = useApi<{ services: Service[] }>('/v1/services', { pollMs: 5000 });
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [created, setCreated] = useState<Service | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const dec = cfg?.token.decimals ?? 6;
  const sym = cfg?.token.symbol ?? '';
  const circuit = cfg?.circuits[form.template];
  const priceBase = parseAmount(form.price, dec);
  const exampleQuote = 108320;
  const tolPreview = useMemo(() => {
    const bps = Number(form.toleranceBps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return null;
    return toleranceFromBps(exampleQuote, bps);
  }, [form.toleranceBps]);

  const problems: string[] = [];
  if (!form.name.trim()) problems.push('name');
  if (!/^https?:\/\//.test(form.upstreamUrl)) problems.push('upstream URL (http/https)');
  if (!priceBase || priceBase <= 0n) problems.push('price');
  if (!isAddress(form.payee)) problems.push('payee address');
  if (!isAddress(form.signer)) problems.push('signer address');
  const chainBlocked = cfg?.mode === 'chain' && circuit?.status === 'pending-partner';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problems.length || !cfg) return;
    setSubmitting(true);
    setError(null);
    try {
      const meta = {
        name: form.name.trim(),
        template: form.template,
        upstreamUrl: form.upstreamUrl.trim(),
        toleranceBps: form.template === 'B' ? Number(form.toleranceBps) : 0,
        slaSeconds: Number(form.slaSeconds),
        valueDecimals: Number(form.valueDecimals),
        description: form.description,
      };
      let svc: Service;
      if (cfg.mode === 'simulated') {
        svc = await api<Service>('/v1/services', {
          json: { ...meta, price: priceBase!.toString(), grace: Number(form.grace), payee: form.payee, signer: form.signer },
        });
      } else {
        const eth = (window as any).ethereum;
        if (!eth) throw new Error('Registering on-chain needs a browser wallet (e.g. OKX Wallet or MetaMask) on X Layer.');
        const provider = new BrowserProvider(eth);
        await provider.send('eth_requestAccounts', []);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== cfg.chainId) {
          await provider.send('wallet_switchEthereumChain', [{ chainId: '0x' + cfg.chainId.toString(16) }]);
        }
        const signer = await provider.getSigner();
        const escrow = new Contract(cfg.escrow, CLAUSE_ESCROW_ABI as unknown as string[], signer);
        const c = cfg.circuits[form.template];
        const tx = await escrow.registerService(c.processor, BigInt(c.circuitId), form.payee, form.signer, cfg.gatewayAddress, cfg.token.address, priceBase!, Number(form.grace));
        const rc = await tx.wait();
        const ev = rc.logs.map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } }).find((l: any) => l?.name === 'ServiceRegistered');
        if (!ev) throw new Error('ServiceRegistered event not found in the transaction');
        svc = await api<Service>('/v1/services', { json: { ...meta, serviceId: ev.args.serviceId.toString(), txHash: rc.hash } });
      }
      setCreated(svc);
      setSelected(svc.id);
      services.reload();
    } catch (e: any) {
      setError(e instanceof ApiError ? e : new Error(e?.shortMessage ?? e?.message ?? String(e)));
    } finally {
      setSubmitting(false);
    }
  }

  const list = services.data?.services ?? [];
  const focus = list.find((s) => s.id === selected) ?? created ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§ Seller console</div>
          <h1>Offer refunds your buyers can verify.</h1>
          <p className="lede">
            Pick a rule template and set its parameters. The rule compiles to an immutable circuit, and that circuit, not you or us, decides each refund.
            Show the badge so agents know the deal before they pay.
          </p>
        </div>
      </div>

      <div className="grid-2 even">
        <form className="card" onSubmit={submit} noValidate>
          <div className="card-head">
            <h2>
              <span className="section-mark">§1</span>Register a service
            </h2>
            {cfg && <span className="tiny muted">{cfg.mode === 'simulated' ? 'simulated registry' : `ClauseEscrow on chain ${cfg.chainId}`}</span>}
          </div>
          <div className="card-pad stack">
            <div className="template-cards" role="radiogroup" aria-label="Rule template">
              {(['E', 'B'] as const).map((t) => (
                <button type="button" key={t} className="template-card" aria-pressed={form.template === t} role="radio" aria-checked={form.template === t} onClick={() => setForm((f) => ({ ...f, template: t }))}>
                  <div className="spread">
                    <span className="t">Template {t} · {TEMPLATES[t].name}</span>
                    <span className="tiny muted">{TEMPLATES[t].gateBudget}</span>
                  </div>
                  <div className="rule">{TEMPLATES[t].rule}</div>
                  <div className="tiny muted" style={{ marginTop: 6 }}>{TEMPLATES[t].useCase}</div>
                </button>
              ))}
            </div>

            {circuit && (
              <div className="notice">
                <div className="spread">
                  <span>
                    Circuit <span className="mono">{circuit.circuitId}</span> {circuit.processor && cfg?.mode === 'chain' && <span className="mono tiny">@ {short(circuit.processor)}</span>}
                  </span>
                  <CircuitChip status={circuit.status} />
                </div>
                <div className="tiny" style={{ marginTop: 6 }}>
                  {circuit.tapeoutUrl ? (
                    <a href={circuit.tapeoutUrl} target="_blank" rel="noreferrer">
                      View the taped-out circuit ↗
                    </a>
                  ) : (
                    <span className="muted">The tape-out link appears here once the TapeOut integration publishes the circuit.</span>
                  )}
                </div>
              </div>
            )}

            <div className="field-grid">
              <label className="field">
                <span>Service name</span>
                <input value={form.name} onChange={set('name')} placeholder="Weather now" maxLength={80} />
              </label>
              <label className="field">
                <span>Price per call ({sym})</span>
                <input value={form.price} onChange={set('price')} inputMode="decimal" />
                <small>{priceBase ? `${priceBase} base units` : 'invalid amount'}</small>
              </label>
            </div>
            <label className="field">
              <span>Upstream URL</span>
              <input className="mono" value={form.upstreamUrl} onChange={set('upstreamUrl')} placeholder="https://api.example.com/clause" />
              <small>Must implement <code>/quote</code> and <code>/deliver</code> (seller protocol below).</small>
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Deadline after quote (s)</span>
                <input value={form.slaSeconds} onChange={set('slaSeconds')} inputMode="numeric" />
              </label>
              <label className="field">
                <span>Grace (s, immutable)</span>
                <input value={form.grace} onChange={set('grace')} inputMode="numeric" />
              </label>
              {form.template === 'B' && (
                <label className="field">
                  <span>Tolerance (bps)</span>
                  <input value={form.toleranceBps} onChange={set('toleranceBps')} inputMode="numeric" />
                  <small>
                    {tolPreview !== null ? `Quote ${fixed(exampleQuote, 5)} → ±${fixed(tolPreview, 5)}. Computed off-chain, so no multiplier in gates.` : '0–10000'}
                  </small>
                </label>
              )}
              <label className="field">
                <span>Value decimals</span>
                <input value={form.valueDecimals} onChange={set('valueDecimals')} inputMode="numeric" />
              </label>
            </div>
            <label className="field">
              <span>Payee (receives price − fee)</span>
              <input className="mono" value={form.payee} onChange={set('payee')} placeholder="0x…" />
            </label>
            <label className="field">
              <span>Signer (signs every delivery)</span>
              <input className="mono" value={form.signer} onChange={set('signer')} placeholder="0x…" />
            </label>
            <label className="field">
              <span>Description (optional)</span>
              <input value={form.description} onChange={set('description')} maxLength={280} />
            </label>

            <ErrorBox error={error} />
            {chainBlocked && <div className="notice warn">On-chain registration is waiting for the TapeOut integration to supply this template's circuit ID and processor.</div>}
            <button className="btn big block" type="submit" disabled={submitting || problems.length > 0 || chainBlocked}>
              {submitting ? 'Registering…' : cfg?.mode === 'chain' ? 'Register on-chain with my wallet' : 'Register service'}
            </button>
            {problems.length > 0 && <p className="tiny muted">Still needed: {problems.join(', ')}.</p>}
            <p className="tiny muted">Every field becomes immutable at registration. There's no owner and no admin path.</p>
          </div>
        </form>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>
                <span className="section-mark">§2</span>Services
              </h2>
              <span className="tiny muted">earnings · refund rate</span>
            </div>
            {services.loading && !services.data ? (
              <div className="card-pad"><Loading /></div>
            ) : services.error ? (
              <div className="card-pad"><ErrorBox error={services.error} onRetry={services.reload} /></div>
            ) : list.length === 0 ? (
              <div className="empty">No services yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Calls</th>
                      <th>Earned</th>
                      <th>Refunds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id} onClick={() => setSelected(s.id)} style={{ cursor: 'pointer', background: focus?.id === s.id ? 'var(--paper-2)' : undefined }}>
                        <td>
                          <button type="button" className="btn sm ghost" style={{ border: 0, padding: 0, height: 'auto', fontWeight: 600 }} onClick={() => setSelected(s.id)}>
                            #{s.id} {s.name}
                          </button>
                          <div className="tiny muted">Template {s.template} · {formatAmount(s.price, dec)} {sym}</div>
                        </td>
                        <td className="mono">{s.stats.calls}</td>
                        <td className="mono">{formatAmount(s.stats.sellerEarnings, dec)}</td>
                        <td className="mono">{s.stats.paid + s.stats.refunded ? pct(s.refundRate) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {focus && (
            <section className="card">
              <div className="card-head">
                <h2>
                  <span className="section-mark">§3</span>
                  {created?.id === focus.id ? 'Registered! Show the badge' : `#${focus.id} ${focus.name}`}
                </h2>
                <a className="small" href={href('/rules', { service: focus.id })}>
                  Test its rule →
                </a>
              </div>
              <div className="card-pad stack">
                <div className="stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
                  <div className="stat">
                    <div className="k">Earned</div>
                    <div className="v" style={{ fontSize: 20 }}>{formatAmount(focus.stats.sellerEarnings, dec)}</div>
                  </div>
                  <div className="stat">
                    <div className="k">Refund rate</div>
                    <div className="v" style={{ fontSize: 20 }}>{focus.stats.paid + focus.stats.refunded ? pct(focus.refundRate) : '—'}</div>
                  </div>
                  <div className="stat">
                    <div className="k">Paid / refunded</div>
                    <div className="v" style={{ fontSize: 20 }}>{focus.stats.paid} / {focus.stats.refunded}</div>
                  </div>
                </div>
                <div>
                  <img src={`${origin()}/v1/services/${focus.id}/badge.svg?t=${focus.stats.calls}`} alt="Refund-protected by Clause badge" height={22} />
                </div>
                <div>
                  <b className="small">Badge snippet</b>
                  <Snippet
                    code={`<a href="${webBase()}#/sellers">\n  <img src="${origin()}/v1/services/${focus.id}/badge.svg"\n       alt="Refund-protected by Clause" height="22">\n</a>`}
                  />
                </div>
                <div>
                  <b className="small">Agents call it like this (x402)</b>
                  <Snippet
                    code={`import { ClauseClient } from '@clause/core';\nconst client = new ClauseClient({ signer, maxPrice: ${focus.price}n });\nconst res = await client.fetch('${focus.endpoint}?pair=EURUSD');\n// 402 → verify plaintext quote → sign voucher → 200 + PAYMENT-RESPONSE`}
                  />
                </div>
                <div>
                  <b className="small">Seller protocol: sign every delivery</b>
                  <Snippet
                    code={`// GET {upstream}/quote   → exact bytes, header X-Clause-Value\n// GET {upstream}/deliver → bytes + X-Clause-Value + X-Clause-Signature\nimport { clauseDomain, hash8, signSellerReceipt } from '@clause/core';\nconst sig = await signSellerReceipt(signerWallet,\n  clauseDomain(${cfg?.chainId ?? 196}, '${cfg?.escrow ?? '<escrow>'}'),\n  { callId, responseHash: hash8(bodyBytes), deliveredValue });`}
                  />
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
