import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type GatewayConfig } from './api';

export interface Async<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch JSON from the gateway; optional polling. Keeps the previous data while refreshing. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const d = await api<T>(path, { signal: ctl.signal });
        setData(d);
        setError(null);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(0, String(e?.message ?? e)));
      } finally {
        if (!ctl.signal.aborted) {
          setLoading(false);
          if (opts.pollMs) timer = setTimeout(run, opts.pollMs);
        }
      }
    };
    setLoading(true);
    void run();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [path, nonce, opts.pollMs]);

  return { data, error, loading, reload };
}

let configPromise: Promise<GatewayConfig> | null = null;
export function useConfig(): Async<GatewayConfig> {
  const [state, setState] = useState<{ data: GatewayConfig | null; error: ApiError | null }>({ data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!configPromise) configPromise = api<GatewayConfig>('/v1/config');
    configPromise.then(
      (data) => setState({ data, error: null }),
      (error) => {
        configPromise = null;
        setState({ data: null, error });
      },
    );
  }, [nonce]);
  return { ...state, loading: !state.data && !state.error, reload: () => setNonce((n) => n + 1) };
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
