import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/page.css';
import './styles/shell.css';

import { getSession, initSession, startSessionWatch, subscribe } from '../data/session';
import { startSplash } from './shell/splash';
import { syncDocumentBrand } from '../brand';
import { ToastHost } from './ui/Toast';
import { Gate } from './shell/Gate';
import Home from './routes/Home';
import Orders from './routes/Orders';
import OrderDetail from './routes/OrderDetail';
import Products from './routes/Products';
import ProductDetail from './routes/ProductDetail';
import Inventory from './routes/Inventory';
import Reviews from './routes/Reviews';
import DeliveryAreas from './routes/DeliveryAreas';
import Categories from './routes/Categories';
import AddOns from './routes/AddOns';
import Customers from './routes/Customers';
import Featured from './routes/Featured';
import Banners from './routes/Banners';
import Spools from './routes/Spools';
import SpoolsAnalytics from './routes/SpoolsAnalytics';
import SpoolsAnalyticsAreas from './routes/SpoolsAnalyticsAreas';
import SpoolsAreas from './routes/SpoolsAreas';
import SpoolsRates from './routes/SpoolsRates';
import Marketing from './routes/Marketing';
import Settings from './routes/Settings';
import SettingsShipping from './routes/SettingsShipping';
import SettingsTeam from './routes/SettingsTeam';
import SettingsWriting from './routes/SettingsWriting';
import EmailBroadcasts from './routes/EmailBroadcasts';
import EmailTemplates from './routes/EmailTemplates';
import EmailSubscribers from './routes/EmailSubscribers';
import EmailOutbox from './routes/EmailOutbox';
import Posts from './routes/Posts';
import PostEditor from './routes/PostEditor';
import PostEditorAdvanced from './routes/PostEditorAdvanced';
import Analytics from './routes/Analytics';
import AnalyticsProducts from './routes/AnalyticsProducts';
import Discounts from './routes/Discounts';
import DiscountNew from './routes/DiscountNew';
import DesignGallery from './routes/DesignGallery';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ADMIN UI v2 — ENTRY POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── HOW TO REVERT TO v1 ────────────────────────────────────────────────────
 *
 * One line, in `index.html`:
 *
 *     <script type="module" src="/src/v2/main.tsx"></script>   ← v2 (current)
 *     <script type="module" src="/src/main.tsx"></script>      ← v1
 *
 * That is the whole switch. Nothing under `src/` outside `src/v2/` was edited
 * to make v2 work: `src/main.tsx`, `src/styles/*`, `src/components/*` and every
 * `src/routes/*` screen are byte-for-byte what they were, so flipping the line
 * restores v1 exactly, including its dark theme and its neobrutalist cards.
 *
 * ── WHAT v2 SHARES WITH v1, AND WHAT IT DOES NOT ───────────────────────────
 *
 * SHARED — the data layer only: `src/data/*` and `shared/*`. Those are the API
 * clients, the session machinery and the types. A second copy of `session.ts`
 * would be a second answer to "who is signed in" and a second scope key for the
 * offline cache. One measured exception since 2026-08-31: the splash ENGINE
 * (`src/components/splash-engine.js`), a standalone brand-agnostic ES5 asset
 * with no CSS and no imports — shared like a font, orchestrated by v2's own
 * `src/v2/shell/splash.ts`. No v1 screen or style rides along with it.
 *
 * NOT SHARED — every pixel. No v1 component is mounted anywhere in this build,
 * including on the routes v2 has not redesigned yet: those render `Soon`, a real
 * v2 screen that names what is still owed. Mounting a v1 screen inside the v2
 * shell would put a green neobrutalist card in the middle of the comparison this
 * build exists to make.
 *
 * ── ONE NEW FILE OUTSIDE `src/v2/`: NONE ───────────────────────────────────
 *
 * The discounts write client lives at `src/v2/data/discounts.ts` rather than
 * being appended to `src/data/api-marketing.ts`, for the same revert reason.
 */

/* The tab title, favicon and social identity come from the same brand
   contract v1 reads — `src/brand.ts` is data, not UI, so sharing it is the
   same call as sharing the session machinery. */
syncDocumentBrand();

/* The session is asked for immediately and nothing blocks on the answer —
   `Gate` renders null while it is `unknown`. Same contract as v1. */
void initSession();
startSessionWatch();

/*
 * The opening sequence (owner's instruction, 2026-08-31), up before
 * `createRoot` so it is on screen ahead of React's first frame. It ends when
 * the session stops being `unknown` — exactly the window `Gate` spends
 * rendering nothing — so it decorates a blank the app was already showing
 * rather than adding time to the boot. `subscribe` rather than awaiting
 * `initSession()`: the answer can also arrive via `startSessionWatch`, and a
 * promise here would miss that and leave the splash up until its own ceiling.
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

const router = createHashRouter([
  /*
   * `#/design` — the design system on one page, OUTSIDE the gate. It fetches
   * nothing and renders only sample data, so there is nothing to protect, and
   * reviewing components must not require production credentials.
   */
  { path: '/design', element: <DesignGallery /> },
  {
    element: <Gate />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: '/home', element: <Home /> },

      /* ── orders ──────────────────────────────────────────────────────── */
      { path: '/orders', element: <Orders /> },
      { path: '/orders/:id', element: <OrderDetail /> },
      { path: '/orders/delivery', element: <DeliveryAreas /> },

      /* ── spools ──────────────────────────────────────────────────────── */
      /* Returned items, as a section of their own: the pickup queue at the
         root, then what they cost us (charts, and the district table as its
         own subpage — the same split `/analytics` uses), the programme's
         points and money, and the map of districts a driver collects from. */
      { path: '/spools', element: <Spools /> },
      { path: '/spools/analytics', element: <SpoolsAnalytics /> },
      { path: '/spools/analytics/areas', element: <SpoolsAnalyticsAreas /> },
      { path: '/spools/rates', element: <SpoolsRates /> },
      { path: '/spools/areas', element: <SpoolsAreas /> },
      /* Where these screens lived until 2026-09-06. Bookmarks and mailed
         links keep working; `replace`, so Back does not bounce through the
         old address. */
      { path: '/orders/returns', element: <Navigate to="/spools" replace /> },
      { path: '/orders/returns/analytics', element: <Navigate to="/spools/analytics" replace /> },
      {
        path: '/orders/returns/analytics/areas',
        element: <Navigate to="/spools/analytics/areas" replace />,
      },

      /* ── products ────────────────────────────────────────────────────── */
      { path: '/products', element: <Products /> },
      { path: '/products/categories', element: <Categories /> },
      { path: '/products/inventory', element: <Inventory /> },
      { path: '/products/reviews', element: <Reviews /> },
      { path: '/products/add-ons', element: <AddOns /> },
      /* Static beats dynamic in the router's ranking, but the create route is
         listed first anyway so nobody has to know that. */
      { path: '/products/new', element: <ProductDetail create /> },
      { path: '/products/:id', element: <ProductDetail /> },

      /* ── customers, discounts ────────────────────────────────────────── */
      { path: '/customers', element: <Customers /> },
      { path: '/discounts', element: <Discounts /> },
      { path: '/discounts/new', element: <DiscountNew /> },

      /* ── content ─────────────────────────────────────────────────────── */
      { path: '/content', element: <Navigate to="/content/posts" replace /> },
      { path: '/content/posts', element: <Posts /> },
      { path: '/content/posts/new', element: <PostEditor create /> },
      { path: '/content/posts/:id', element: <PostEditor /> },
      /* The v1 writing studio, ported under src/v2/advanced — reachable from
         the quick editor's More actions, or as the device default (Settings →
         Writing). */
      { path: '/content/posts/:id/advanced', element: <PostEditorAdvanced /> },
      { path: '/content/featured', element: <Featured /> },
      { path: '/content/banners', element: <Banners /> },

      /* ── marketing, emails ───────────────────────────────────────────── */
      { path: '/marketing', element: <Marketing /> },
      { path: '/emails', element: <Navigate to="/emails/broadcasts" replace /> },
      { path: '/emails/broadcasts', element: <EmailBroadcasts /> },
      { path: '/emails/templates', element: <EmailTemplates /> },
      { path: '/emails/subscribers', element: <EmailSubscribers /> },
      { path: '/emails/outbox', element: <EmailOutbox /> },
      { path: '/analytics', element: <Analytics /> },
      { path: '/analytics/products', element: <AnalyticsProducts /> },

      /* ── settings ────────────────────────────────────────────────────── */
      { path: '/settings', element: <Settings /> },
      { path: '/settings/shipping', element: <SettingsShipping /> },
      { path: '/settings/team', element: <SettingsTeam /> },
      { path: '/settings/writing', element: <SettingsWriting /> },

      /* A typo lands on Home rather than on a blank. `replace`, so Back does
         not return to the URL that matched nothing. */
      { path: '*', element: <Navigate to="/home" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastHost>
      <RouterProvider router={router} />
    </ToastHost>
  </StrictMode>,
);
