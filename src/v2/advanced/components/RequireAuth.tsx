/**
 * v2 port: shim, not a copy. The copied editor imports only `useSession` from
 * '../components/RequireAuth'; v1's guard/shell (RequireAuth, AppShell, the
 * reauth prompt) stays in v1 — v2 has its own Gate. The hook body below is
 * verbatim from src/components/RequireAuth.tsx, reading the SAME shared
 * session store v2 already uses (src/data/session.ts).
 */
import { useSyncExternalStore } from 'react';
import { getSession, subscribe, type Session } from '../../../data/session';

/**
 * The session as a React value.
 *
 * `useSyncExternalStore` rather than a context provider because the store is a
 * plain module — `session.ts` is imported by the entry point before React
 * mounts, so that it can call `setActiveUser` before any route renders, and a
 * provider could not have been read that early.
 */
export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}
