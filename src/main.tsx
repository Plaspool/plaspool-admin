import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
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
import { getSession, initSession, startSessionWatch, subscribe } from './data/session';
import { startSplash } from './components/splash';
import Boot from './routes/Boot';
import Login from './routes/Login';
import Dashboard from './routes/Dashboard';
import Featured from './routes/Featured';
import EditorRoute from './routes/Editor';
import Reader from './routes/Reader';
import SettingsRoute from './routes/Settings';
import AcceptInvite from './routes/AcceptInvite';
import Forgot from './routes/Forgot';
import Reset from './routes/Reset';
import Recover from './routes/Recover';
import MigrateRoute from './routes/Migrate';
import Shop from './routes/Shop';
import ShopProducts from './routes/ShopProducts';
import ShopCategories from './routes/ShopCategories';
import ShopShippingZones from './routes/ShopShippingZones';
import ShopDeliveryAreas from './routes/ShopDeliveryAreas';
import ShopOrders from './routes/ShopOrders';
import ShopCustomers from './routes/ShopCustomers';
import ShopAudit from './routes/ShopAudit';
import ShopReviews from './routes/ShopReviews';
import EmailTemplates from './routes/EmailTemplates';
import EmailBroadcasts from './routes/EmailBroadcasts';
import EmailSubscribers from './routes/EmailSubscribers';
import MarketingOverview from './routes/MarketingOverview';
import MarketingReturns from './routes/MarketingReturns';
import MarketingRewards from './routes/MarketingRewards';
import MarketingCustomers from './routes/MarketingCustomers';
import MarketingBanners from './routes/MarketingBanners';
import MarketingDiscounts from './routes/MarketingDiscounts';
import MarketingAreas from './routes/MarketingAreas';

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

/**
 * The opening sequence, and the moment it is allowed to end.
 *
 * It goes up here — after the theme and the accent are in the cascade, so it
 * cannot paint in the wrong palette, and before `createRoot` so it is on screen
 * ahead of React's first frame.
 *
 * It ends when the session stops being `unknown`, which is exactly the window
 * `RequireAuth` spends returning `null`. That is the whole justification for
 * having a splash at all: it decorates a blank the app was already showing
 * rather than adding time to the boot. On a warm start `/auth/me` answers in a
 * few milliseconds, so `finish()` is usually called almost immediately and only
 * shortens what is left; on a cold serverless start it is the tips that cover
 * the wait.
 *
 * `subscribe` rather than awaiting `initSession()`: the answer can also arrive
 * via `startSessionWatch`, and a promise here would miss that and leave the
 * splash up until its own ceiling.
 */
const endSplash = startSplash();
if (getSession().status !== 'unknown') {
  endSplash();
} else {
  const stopWatching = subscribe(() => {
    if (getSession().status === 'unknown') return;
    stopWatching();
    endSplash();
  });
}

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
  /*
   * OUTSIDE THE GUARD FOR THE SAME REASON, and here it is even starker: a
   * writer who has forgotten their password is by definition someone the guard
   * cannot let through. Behind it, both screens would render the sign-in form —
   * the one thing the person opening them cannot get past — and `/reset` would
   * lose its token on the way.
   *
   * `/reset` matches `RESET_PATH` in `server/routes/auth.ts` (`/#/reset`), so
   * the token the mail carries lands in the in-hash query where
   * `useSearchParams` reads it.
   */
  { path: '/forgot', element: <Forgot />, errorElement: <RouteError /> },
  { path: '/reset', element: <Reset />, errorElement: <RouteError /> },
  /*
   * THE INDEX IS A GATEWAY, NOT THE DASHBOARD. It renders nothing, the opening
   * sequence plays over it, and it then sends the visitor to `/dashboard` or
   * `/login` depending on who `/auth/me` says they are.
   *
   * Outside the guard, and that is the point: the guard's job is to bounce an
   * unauthenticated visitor to sign-in, which is exactly what must NOT happen
   * before the sequence has played. `Boot` makes that decision itself, once it
   * has both answers.
   */
  { path: '/', element: <Boot />, errorElement: <RouteError /> },
  /*
   * Sign-in is a route of its own now rather than something `RequireAuth`
   * rendered in place. Outside the guard for the same reason `/accept-invite`
   * is: whoever lands here cannot satisfy it.
   */
  { path: '/login', element: <Login />, errorElement: <RouteError /> },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      /*
       * The dashboard moved off `/` so the index could become the gateway.
       * It keeps its five filters in its own query string, so every "back to
       * the dashboard" link in the app points here rather than at `/` — going
       * via the gateway would replay the opening sequence every time someone
       * closed a post.
       */
      { path: '/dashboard', element: <Dashboard />, errorElement: <RouteError /> },
      /*
       * The curated rail. Inside `AppShell` like every other authenticated
       * screen, and NOT behind an owner gate here — the screen renders read-only
       * for a writer, which is what makes the disabled toggle in their editor
       * legible. The enforcement is `requireOwner()` on the server.
       */
      { path: '/featured', element: <Featured />, errorElement: <RouteError /> },
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
       * The shop and the email surface, both inside the guard: every screen
       * under them reads or writes the store on this account's behalf, and
       * `/emails` in particular can reach people who are not users of this app
       * at all.
       *
       * Flat rather than nested, deliberately. A parent route with an `<Outlet/>`
       * would need a layout component to render it, and the only chrome these
       * screens share is the section row each one already draws — one that
       * knows which of its own entries is current. A layout that existed purely
       * to hold a `<Outlet/>` would be a component with nothing in it.
       */
      { path: '/shop', element: <Shop />, errorElement: <RouteError /> },
      { path: '/shop/products', element: <ShopProducts />, errorElement: <RouteError /> },
      { path: '/shop/categories', element: <ShopCategories />, errorElement: <RouteError /> },
      /*
       * DELIVERY IS THE SCREEN; ZONES ARE THE STRUCTURE UNDER IT.
       * `/shop/delivery-areas` is where the sidebar points and where the weekly
       * questions are answered (do we go there, what does it cost).
       * `/shop/shipping-zones` still exists because creating a zone, editing its
       * countries, its tax rate or which one is the fallback has nowhere else to
       * happen — it is linked from the footer of the delivery screen rather than
       * from the nav. See `ShopDeliveryAreas.tsx`'s note on why that is one entry
       * and not two.
       */
      {
        path: '/shop/delivery-areas',
        element: <ShopDeliveryAreas />,
        errorElement: <RouteError />,
      },
      {
        path: '/shop/shipping-zones',
        element: <ShopShippingZones />,
        errorElement: <RouteError />,
      },
      { path: '/shop/orders', element: <ShopOrders />, errorElement: <RouteError /> },
      { path: '/shop/customers', element: <ShopCustomers />, errorElement: <RouteError /> },
      { path: '/shop/reviews', element: <ShopReviews />, errorElement: <RouteError /> },
      { path: '/shop/audit', element: <ShopAudit />, errorElement: <RouteError /> },
      /*
       * `/emails` is a redirect and not a screen of its own — there is no
       * overview worth the click, and `replace` keeps it out of the back stack
       * so Back from Templates leaves the section instead of bouncing through
       * the redirect again. The sidebar links straight to `/emails/templates`
       * for the same reason; this entry exists for a hand-typed URL.
       */
      /*
       * Marketing, flat like the rest and pointed at a real index screen rather
       * than a redirect: `/marketing` is the section's overview, so the rail
       * links straight to it and Back out of it leaves the section.
       *
       * `/marketing/returns` renders both the queue and one request — the detail
       * lives at `?id=`, the way the shop's product editor does. Two routes for
       * a list and its rows would put every record an operator opened into the
       * back stack, and clearing a queue of thirty means thirty presses of Back
       * to get out of it.
       */
      { path: '/marketing', element: <MarketingOverview />, errorElement: <RouteError /> },
      { path: '/marketing/returns', element: <MarketingReturns />, errorElement: <RouteError /> },
      { path: '/marketing/rewards', element: <MarketingRewards />, errorElement: <RouteError /> },
      { path: '/marketing/customers', element: <MarketingCustomers />, errorElement: <RouteError /> },
      { path: '/marketing/banners', element: <MarketingBanners />, errorElement: <RouteError /> },
      /*
       * THE SIXTH SCREEN, and it was written and then never wired — the rail has
       * linked to `/marketing/discounts` since the section shipped, no route
       * matched it, and the catch-all below swallowed the click. A "Planned"
       * screen that says out loud what is not built yet is the entire point of
       * that file; unreachable, it read as a navigation bug instead.
       */
      { path: '/marketing/discounts', element: <MarketingDiscounts />, errorElement: <RouteError /> },
      { path: '/marketing/areas', element: <MarketingAreas />, errorElement: <RouteError /> },
      { path: '/emails', element: <Navigate to="/emails/templates" replace />, errorElement: <RouteError /> },
      { path: '/emails/templates', element: <EmailTemplates />, errorElement: <RouteError /> },
      { path: '/emails/broadcasts', element: <EmailBroadcasts />, errorElement: <RouteError /> },
      { path: '/emails/subscribers', element: <EmailSubscribers />, errorElement: <RouteError /> },
      /*
       * Inside the guard, unlike `/accept-invite`: this screen uploads the
       * pre-backend library under the CURRENT account's name, so it has no
       * meaning without one.
       */
      { path: '/migrate', element: <MigrateRoute />, errorElement: <RouteError /> },
      /*
       * A redirect rather than the dashboard itself. Rendering `<Dashboard/>`
       * under an arbitrary path left the bad URL in the address bar, and now
       * that the dashboard has a real path there is somewhere honest to send
       * a typo. `replace`, so Back does not return to the URL that matched
       * nothing.
       */
      { path: '*', element: <Navigate to="/dashboard" replace />, errorElement: <RouteError /> },
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
