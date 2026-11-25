/** Browser storage wrapped so private windows / blocked storage never break the page. */
const mem = new Map<string, string>();

export function load(key: string, area: 'local' | 'session' = 'local'): string | null {
  try {
    return (area === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return mem.get(`${area}:${key}`) ?? null;
  }
}

export function save(key: string, value: string, area: 'local' | 'session' = 'local') {
  try {
    (area === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    mem.set(`${area}:${key}`, value);
  }
}

export function remove(key: string, area: 'local' | 'session' = 'local') {
  try {
    (area === 'local' ? window.localStorage : window.sessionStorage).removeItem(key);
  } catch {
    mem.delete(`${area}:${key}`);
  }
}
