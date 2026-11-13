'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads a resource and keeps it fresh while the tab is visible. Every fetch is numbered and only
 * the newest answer is used, so a slow poll never puts back state an action just replaced.
 */
export function useResource<T>(
  load: (() => Promise<T>) | null,
  deps: unknown[],
  pollMs?: number,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const mine = ++seq.current;
    try {
      const value = await fn();
      if (mine !== seq.current) return;
      setData(value);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the load depends on.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (pollMs && !cancelled) timer = setTimeout(tick, pollMs);
    };
    const tick = async () => {
      if (document.hidden) return schedule();
      await reload();
      if (!cancelled) schedule();
    };
    void tick();
    const onVisible = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      seq.current++;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [...deps]);

  return { data, error, loading, reload };
}

/** A ticking clock for countdowns, one tick a second. 0 until mounted, so server HTML matches. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
