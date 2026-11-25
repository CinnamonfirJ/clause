export function formatAmount(base: string | bigint | number, decimals: number, maxFrac = 4): string {
  const v = BigInt(base);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const d = 10n ** BigInt(decimals);
  const whole = abs / d;
  let frac = (abs % d).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`;
}

export function parseAmount(text: string, decimals: number): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export function fixed(value: number, decimals: number): string {
  return (value / 10 ** decimals).toFixed(decimals);
}

export function short(hex: string | null | undefined, head = 6, tail = 4): string {
  if (!hex) return '—';
  return hex.length <= head + tail + 2 ? hex : `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
}

export function time(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(unix: number | null | undefined): string {
  if (!unix) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
