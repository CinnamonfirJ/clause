import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bytesToHex,
  encodeInput,
  evaluate,
  FIELD_LAYOUT,
  hexToBytes,
  INPUT_LENGTH,
  mandatoryVectors,
  TEMPLATES,
  type FieldSpec,
  type InputFields,
  type TemplateId,
} from '@clause/core';
import { api, ApiError, type Receipt, type RuleTestResult, type Service } from '../lib/api';
import { useApi, useConfig } from '../lib/hooks';
import { ByteGrid, ByteLegend, CircuitChip, ClauseList, CopyButton, ErrorBox, SOURCE_CLASS } from '../components';

function FieldEditor({ spec, fields, onChange }: { spec: FieldSpec; fields: InputFields; onChange: (f: InputFields) => void }) {
  const v = fields[spec.name];
  const [draft, setDraft] = useState(String(v));
  useEffect(() => setDraft(String(v)), [v]);
  const commit = (raw: string) => {
    try {
      let next: InputFields;
      if (spec.kind === 'hash') {
        const h = raw.startsWith('0x') ? raw : `0x${raw}`;
        if (!/^0x[0-9a-fA-F]{16}$/.test(h)) throw new Error();
        next = { ...fields, [spec.name]: h.toLowerCase() };
      } else {
        const n = Number(raw);
        next = { ...fields, [spec.name]: n };
      }
      encodeInput(next); // validates ranges
      onChange(next);
    } catch {
      setDraft(String(v));
    }
  };
  if (spec.name === 'statusOK') {
    return (
      <div className="seg" role="group" aria-label="statusOK">
        {[1, 0].map((x) => (
          <button key={x} aria-pressed={v === x} onClick={() => onChange({ ...fields, statusOK: x })}>
            {x === 1 ? '1 · OK' : '0 · failed'}
          </button>
        ))}
      </div>
    );
  }
  return (
    <input
      className="mono"
      value={draft}
      aria-label={spec.label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function RuleTester({ params }: { params: URLSearchParams }) {
  const cfg = useConfig().data;
  const services = useApi<{ services: Service[] }>('/v1/services');
  const [serviceId, setServiceId] = useState<string | null>(params.get('service'));
  const [bytes, setBytes] = useState<Uint8Array>(() => {
    try {
      const b = hexToBytes(params.get('input') ?? '');
      if (b.length === INPUT_LENGTH) return b;
    } catch {
      /* default below */
    }
    return hexToBytes(mandatoryVectors()[0].input);
  });
  const [changed, setChanged] = useState<Set<number>>(new Set());
  const [hexDraft, setHexDraft] = useState('');
  const [server, setServer] = useState<RuleTestResult | null>(null);
  const [serverErr, setServerErr] = useState<ApiError | null>(null);
  const [onchain, setOnchain] = useState<RuleTestResult['onchain']>(null);
  const [checking, setChecking] = useState(false);
  const prevVerdict = useRef<number | null>(null);
  const [flipped, setFlipped] = useState(false);

  // Load bytes from a receipt when arriving with ?callId=
  const callId = params.get('callId');
  useEffect(() => {
    if (!callId) return;
    api<Receipt>(`/v1/receipts/${callId}`)
      .then((r) => {
        if (r.input) setBytes(hexToBytes(r.input.hex));
        setServiceId(r.service.id);
      })
      .catch(() => {});
  }, [callId]);

  const list = services.data?.services ?? [];
  const service = list.find((s) => s.id === serviceId) ?? list.find((s) => s.template === 'E') ?? list[0];
  const template: TemplateId = service?.template ?? 'E';
  const local = useMemo(() => evaluate(template, bytes), [template, bytes]);
  const fields = local.fields;
  const hex = bytesToHex(bytes);

  useEffect(() => setHexDraft(hex), [hex]);
  useEffect(() => {
    const prev = prevVerdict.current;
    prevVerdict.current = local.verdict;
    if (prev !== null && prev !== local.verdict) {
      setFlipped(true);
      const t = setTimeout(() => setFlipped(false), 700);
      return () => clearTimeout(t);
    }
  }, [local.verdict]);

  // Gateway cross-check (debounced): same rule, evaluated server-side.
  useEffect(() => {
    if (!service) return;
    setOnchain(null);
    const t = setTimeout(() => {
      api<RuleTestResult>(`/v1/rule/${service.id}/test?input=${hex}`)
        .then((r) => {
          setServer(r);
          setServerErr(null);
        })
        .catch((e) => setServerErr(e));
    }, 250);
    return () => clearTimeout(t);
  }, [service?.id, hex]);

  // Keep the URL shareable.
  useEffect(() => {
    if (!service) return;
    const q = new URLSearchParams({ service: service.id, input: hex });
    const next = `#/rules?${q}`;
    if (window.location.hash !== next) history.replaceState(null, '', next);
  }, [service?.id, hex]);

  function setFromFields(f: InputFields) {
    const next = encodeInput(f);
    const diff = new Set<number>();
    next.forEach((b, i) => b !== bytes[i] && diff.add(i));
    setChanged(diff);
    setBytes(next);
  }

  function editByte(i: number, v: number) {
    const next = bytes.slice();
    next[i] = v & 0xff;
    setChanged(new Set([i]));
    setBytes(next);
  }

  async function verifyOnchain() {
    if (!service) return;
    setChecking(true);
    try {
      const r = await api<RuleTestResult>(`/v1/rule/${service.id}/test?input=${hex}&onchain=1`);
      setOnchain(r.onchain);
    } catch (e: any) {
      setOnchain({ available: false, reason: e.message });
    } finally {
      setChecking(false);
    }
  }

  const presets = mandatoryVectors().filter((v) => v.template === template);
  const agree = server && server.verdict === local.verdict;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§ Rule tester · gas-free · no wallet</div>
          <h1>Edit any of the 41 bytes. Watch the verdict flip.</h1>
          <p className="lede">
            These are the exact bytes the escrow feeds the circuit. Change one and see if the seller still gets paid. Every byte is labelled with the party
            that committed it.
          </p>
        </div>
      </div>

      <ErrorBox error={services.error} onRetry={services.reload} />

      <div className="grid-2">
        <div className="stack">
          <section className="card card-pad stack">
            <label className="field">
              <span>Service / template</span>
              <select value={service?.id ?? ''} onChange={(e) => setServiceId(e.target.value)}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    #{s.id} {s.name} · Template {s.template}
                  </option>
                ))}
              </select>
            </label>
            <p className="mono small">{TEMPLATES[template].rule}</p>
            {service && (
              <div className="row tiny muted">
                circuit ID <span className="mono">{service.circuitId}</span> <CircuitChip status={service.circuitStatus} />
              </div>
            )}
          </section>

          <section className={`verdict ${local.verdict ? 'pay' : 'refund'}`} role="status" aria-live="polite" style={flipped ? { transform: 'scale(1.02)', transition: 'transform .2s' } : { transition: 'transform .2s' }}>
            <div className="big">{local.verdict}</div>
            <div>
              <h2>{local.verdict ? 'Pay seller' : 'Refund buyer'}</h2>
              <p className="small">
                {server ? (agree ? 'Gateway agrees.' : <b>Gateway disagrees: {server.verdict}</b>) : serverErr ? 'Gateway check unavailable.' : 'Checking with the gateway…'}
              </p>
            </div>
          </section>

          <section className="card card-pad">
            <ClauseList clauses={local.clauses} />
          </section>

          <section className="card card-pad stack-sm">
            <div className="spread">
              <b className="small">Verify on-chain</b>
              <button className="btn sm" onClick={verifyOnchain} disabled={checking || !service}>
                {checking ? 'Calling…' : 'previewVerdict()'}
              </button>
            </div>
            <p className="tiny muted">Calls ClauseEscrow.previewVerdict through the service's registered processor. It's a read-only eth_call, so no gas and no wallet.</p>
            {onchain &&
              (onchain.available ? (
                <div className={`notice ${onchain.agrees ? '' : 'err'}`}>
                  On-chain verdict <b>{onchain.verdict}</b>, {onchain.agrees ? 'matches' : 'does NOT match'} the local evaluation.
                  <div className="tiny muted" style={{ marginTop: 4 }}>{onchain.via}</div>
                </div>
              ) : (
                <div className="notice warn">{onchain.reason}</div>
              ))}
          </section>

          <section className="card card-pad stack-sm">
            <b className="small">PRD test vectors</b>
            {presets.map((v) => (
              <button key={v.name} className="btn sm ghost block" style={{ justifyContent: 'space-between' }} onClick={() => { setChanged(new Set()); setBytes(hexToBytes(v.input)); }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name.replace(/^[EB]: /, '')}</span>
                <span className="mono">→ {v.expect}</span>
              </button>
            ))}
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>
                <span className="section-mark">§</span>41-byte input
              </h2>
              <div className="row">
                <CopyButton text={hex} label="Copy hex" />
                <CopyButton text={window.location.href} label="Share link" />
              </div>
            </div>
            <div className="card-pad stack">
              <ByteGrid bytes={bytes} template={template} editable onEdit={editByte} changed={changed} />
              <ByteLegend />
              <p className="tiny muted">Click a byte to edit it. Greyed bytes are ignored by Template {template}.</p>
              <label className="field">
                <span>Raw hex</span>
                <textarea
                  rows={2}
                  value={hexDraft}
                  spellCheck={false}
                  onChange={(e) => setHexDraft(e.target.value)}
                  onBlur={() => {
                    try {
                      const b = hexToBytes(hexDraft.trim());
                      if (b.length !== INPUT_LENGTH) throw new Error();
                      setChanged(new Set());
                      setBytes(b);
                    } catch {
                      setHexDraft(hex);
                    }
                  }}
                />
              </label>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                <span className="section-mark">§</span>Fields
              </h2>
              <span className="tiny muted">decoded, big-endian</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {FIELD_LAYOUT.map((f) => {
                    const [lo, hi] = TEMPLATES[template].ignored;
                    const ign = f.offset >= lo && f.offset < hi;
                    return (
                      <tr key={f.name} style={ign ? { opacity: 0.45 } : undefined}>
                        <td style={{ width: '38%' }}>
                          <div>{f.label}</div>
                          <div className="row tiny" style={{ marginTop: 4 }}>
                            <span className="mono muted">
                              {f.offset}–{f.offset + f.size - 1}
                            </span>
                            <span className={`src ${SOURCE_CLASS[f.source]}`}>{f.source}</span>
                          </div>
                        </td>
                        <td>
                          <FieldEditor spec={f} fields={fields} onChange={setFromFields} />
                          {f.name === 'arrival' && (
                            <div className="row" style={{ marginTop: 6 }}>
                              <button className="btn sm ghost" onClick={() => setFromFields({ ...fields, arrival: Math.min(0xffffffff, fields.deadline + fields.grace) })}>
                                = deadline + grace
                              </button>
                              <button className="btn sm ghost" onClick={() => setFromFields({ ...fields, arrival: Math.min(0xffffffff, fields.deadline + fields.grace + 1) })}>
                                + 1 s late
                              </button>
                            </div>
                          )}
                          {f.name === 'responseHash' && template === 'E' && (
                            <div className="row" style={{ marginTop: 6 }}>
                              <button className="btn sm ghost" onClick={() => setFromFields({ ...fields, responseHash: fields.sealedHash })}>
                                = sealed hash
                              </button>
                              <button
                                className="btn sm ghost"
                                onClick={() => {
                                  const b = hexToBytes(fields.responseHash);
                                  b[7] ^= 1;
                                  setFromFields({ ...fields, responseHash: bytesToHex(b) as `0x${string}` });
                                }}
                              >
                                flip 1 bit
                              </button>
                            </div>
                          )}
                          {f.name === 'deliveredValue' && template === 'B' && (
                            <div className="row" style={{ marginTop: 6 }}>
                              <button className="btn sm ghost" onClick={() => setFromFields({ ...fields, deliveredValue: Math.min(0xffffffff, fields.quotedValue + fields.tolerance) })}>
                                = quoted + tolerance
                              </button>
                              <button className="btn sm ghost" onClick={() => setFromFields({ ...fields, deliveredValue: Math.min(0xffffffff, fields.quotedValue + fields.tolerance + 1) })}>
                                + 1 over
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          {cfg && (
            <p className="tiny muted">
              Local evaluation uses the Clause reference model of the PRD rule. Gate-level netlist simulation and the taped-out circuit belong to the TapeOut
              integration. The on-chain check above is the one that binds.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
