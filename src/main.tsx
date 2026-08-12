import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/prose.css';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initTheme } from './components/ThemeToggle';
import { syncDocumentBrand } from './brand';
import { RouteError } from './components/RouteError';
import { TooltipProvider } from './components/ui/Switch';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { AppShell } from './components/RequireAuth';
import { PostGate } from './components/PostGate';
import { initSession, startSessionWatch } from './data/session';
import Dashboard from './routes/Dashboard';
import EditorRoute from './routes/Editor';
import Reader from './routes/Reader';
import SettingsRoute from './routes/Settings';
import AcceptInvite from './routes/AcceptInvite';
import Recover from './routes/Recover';
import MigrateRoute from './routes/Migrate';

// Hash routing: this app is pure static and must work from file:// or any
// host without server rewrite rules.
// Apply the saved theme before first paint so there is no light flash.
initTheme();
// Same reason, and same moment: the brand's accent has to be in the cascade
// before anything paints, or the first frame renders in the design system's
// default green and then snaps to the publication's colour.
syncDocumentBrand();

/**
 * EVERY INVITE LINK MINTED BEFORE THE `INVITE_PATH` FIX IS DEAD, AND THIS IS
 * WHAT REVIVES THEM (plan §0 F3).
 *
 * The server used to build `https://host/accept-invite?token=…`. Under
 * `createHashRouter` the router only ever looks at `location.hash`, so that
 * token landed in `location.search` where nothing reads it — the invitee got
 * the dashboard's catch-all route and no way to claim their account. The
 * server now mints `/#/accept-invite?token=…`; this rewrites the old shape for
 * every link already sitting in someone's inbox.
 *
 * It runs BEFORE `createHashRouter`, because the router reads `location.hash`
 * as it is constructed and a rewrite afterwards would need a reload to be
 * noticed. `replaceState` rather than assigning `location.href`, so the dead
 * URL does not stay in the back stack.
 */
function rescueLegacyInviteLink(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (!pathname.endsWith('/accept-invite') || hash !== '' || search === '') return;
  const base = pathname.slice(0, -'/accept-invite'.length);
  window.history.replaceState(null, '', `${base}/#/accept-invite${search}`);
}
rescueLegacyInviteLink();

/*
 * Ask who this is, immediately, and never block the first paint on the answer.
 *
 * `RequireAuth` renders nothing at all while the session is `unknown`, which is
 * what makes `session.ts`'s `setActiveUser` provably earlier than any route:
 * no route can mount until this call has decided, and `src/data/posts.ts` reads
 * that ambient id on every write because the frozen `useAutosave.ts:85` has no
 * argument to pass one in.
 */
void initSession();
startSessionWatch();

// Offline shell. Production only — a service worker in dev fights HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline capability is a bonus, never a requirement to run.
    });
  });
}

// Every route gets our own error element. Without this, React Router's default
// boundary catches render errors first and shows its own stack-trace page —
// which reads like the app ate your writing.
const router = createHashRouter([
  /*
   * OUTSIDE THE GUARD, and it has to be: the whole point of this screen is that
   * whoever opened it has no account yet. `RequireAuth` would show them a login
   * form they cannot satisfy and swallow the token in the process.
   */
  { path: '/accept-invite', element: <AcceptInvite />, errorElement: <RouteError /> },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Dashboard />, errorElement: <RouteError /> },
      {
        path: '/edit/:id',
        // The gate decides what may be rendered for this id BEFORE the frozen
        // editor sees a row — see PostGate's own header for why the order of
        // its arms is the point.
        element: (
          <PostGate mode="edit">
            <EditorRoute />
          </PostGate>
        ),
        errorElement: <RouteError />,
      },
      {
        path: '/read/:id',
        element: (
          <PostGate mode="read">
            <Reader />
          </PostGate>
        ),
        errorElement: <RouteError />,
      },
      { path: '/settings', element: <SettingsRoute />, errorElement: <RouteError /> },
      { path: '/recover', element: <Recover />, errorElement: <RouteError /> },
      /*
       * Inside the guard, unlike `/accept-invite`: this screen uploads the
       * pre-backend library under the CURRENT account's name, so it has no
       * meaning without one.
       */
      { path: '/migrate', element: <MigrateRoute />, errorElement: <RouteError /> },
      { path: '*', element: <Dashboard />, errorElement: <RouteError /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
          {/* Above the router: the shortcuts it describes belong to the app,
              not to whichever screen happens to be mounted. */}
          <ShortcutsDialog />
        </ToastProvider>
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
