/**
 * SSRF guard for seller-supplied upstream URLs. The gateway fetches whatever URL a seller
 * registers, so on a public deployment it must refuse loopback / private / link-local targets.
 * Enabled when ALLOW_PRIVATE_UPSTREAMS=false (default in production).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  if (x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return true;
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? ipv4Private(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? ipv4Private(ip) : isIP(ip) === 6 ? ipv6Private(ip) : true;
}

export async function assertUpstreamAllowed(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('upstream URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('upstream URL must be http(s)');
  if (url.username || url.password) throw new Error('upstream URL must not contain credentials');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('upstream URL resolves to a private or loopback address');
  }
  return url;
}
