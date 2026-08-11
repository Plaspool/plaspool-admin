import { useEffect, useState } from 'react';

/**
 * True only once `active` has been true for `delay` ms.
 *
 * Stops loaders from flashing on fast operations — IndexedDB usually answers
 * in under 50ms, so an undelayed skeleton appears and vanishes within a single
 * blink, which reads as a glitch rather than as loading.
 */
export function useDelayed(active: boolean, delay = 250): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(t);
  }, [active, delay]);

  return shown;
}

/**
 * True while `active`, and for at least `minMs` after it first became true.
 *
 * The mirror problem: a spinner that appears and is torn down 60ms later
 * flickers. Once we have committed to showing one, we hold it briefly.
 */
export function useMinDuration(active: boolean, minMs = 400): boolean {
  const [held, setHeld] = useState(active);

  useEffect(() => {
    if (active) {
      setHeld(true);
      return;
    }
    const t = window.setTimeout(() => setHeld(false), minMs);
    return () => window.clearTimeout(t);
  }, [active, minMs]);

  return held;
}
