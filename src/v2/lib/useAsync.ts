import { useCallback, useEffect, useState } from 'react';

/**
 * One loader for every v2 list screen.
 *
 * WHY IT ABORTS. Every screen here is one route change away from another, and a
 * response that lands after the component unmounted sets state on nothing —
 * React 19 no longer warns about it, which makes it silent rather than absent.
 * The `AbortSignal` is passed through to the api client, all of which already
 * take one.
 *
 * WHY `AbortError` IS SWALLOWED. An aborted request is not a failure, it is a
 * cancellation this hook asked for. Reporting it would flash "Couldn't load
 * orders" every time somebody clicked through the rail quickly.
 */
export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(run: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    setError(null);

    run(controller.signal)
      .then((value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
        setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
