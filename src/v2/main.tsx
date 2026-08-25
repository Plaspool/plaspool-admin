import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import {
  BarChart3,
  FileText,
  LayoutTemplate,
  Mail,
  Megaphone,
  Package,
  Receipt,
  Settings,
  Star,
  Truck,
} from 'lucide-react';

import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/page.css';
import './styles/shell.css';

import { initSession, startSessionWatch } from '../data/session';
import { syncDocumentBrand } from '../brand';
import { ToastHost } from './ui/Toast';
import { Gate } from './shell/Gate';
import { Soon } from './routes/Soon';
import Home from './routes/Home';
import Orders from './routes/Orders';
import Products from './routes/Products';
import Categories from './routes/Categories';
import Customers from './routes/Customers';
import Posts from './routes/Posts';
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
 * offline cache.
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
      {
        path: '/orders/:id',
        element: (
          <Soon
            title="Order"
            icon={<Receipt />}
            what="Order detail is where you fulfil, cancel and refund an order."
            todos={[
              'The order header: number, buyer, payment state and the frozen totals',
              'Line items with fulfilled-vs-ordered quantities',
              'Create a fulfilment, and move one to shipped or delivered',
              'Cancel with the refund choice, and refund a payment directly',
              'The timeline, and the email intents queued against this order',
            ]}
          />
        ),
      },
      {
        path: '/orders/returns',
        element: (
          <Soon
            title="Returns"
            icon={<Truck />}
            what="Returns is the pickup queue — request, schedule, collect, inspect, award."
            todos={[
              'The queue with its five views and real counts per tab',
              'The district board and the out-of-area footer',
              'Schedule a pickup with driver name and phone',
              'Inspection, and the points award that follows it',
            ]}
          />
        ),
      },
      {
        path: '/orders/delivery',
        element: (
          <Soon
            title="Delivery areas"
            icon={<Truck />}
            what="Delivery areas are the districts a van goes to and what each one costs."
            todos={[
              'The area list grouped by region',
              'Editing a rate — Abuja ₦3,000, Lagos ₦10,000, elsewhere ₦10,000 today',
              'Activating and deactivating an area',
              'A note that the storefront does not send a district at checkout yet',
            ]}
          />
        ),
      },

      /* ── products ────────────────────────────────────────────────────── */
      { path: '/products', element: <Products /> },
      { path: '/products/categories', element: <Categories /> },
      {
        path: '/products/inventory',
        element: (
          <Soon
            title="Inventory"
            icon={<Package />}
            what="Inventory is stock on hand, what is reserved, and what is left to sell."
            todos={[
              'The variant table with on-hand, reserved and available',
              'Adjusting stock, with the audit entry it writes',
              'The low-stock threshold and its filter',
              'Backorderable variants, which can go negative on purpose',
            ]}
          />
        ),
      },
      {
        path: '/products/reviews',
        element: (
          <Soon
            title="Reviews"
            icon={<Star />}
            what="Reviews are what customers wrote about a product, pending your approval."
            todos={[
              'The moderation queue',
              'Approve and reject, with the storefront effect stated',
              'Filtering by product and by rating',
            ]}
          />
        ),
      },
      {
        path: '/products/:id',
        element: (
          <Soon
            title="Product"
            icon={<Package />}
            what="Product detail is where the title, description, images, variants and prices live."
            todos={[
              'Title, slug, description and the category picker',
              'Images, with a cover and the rest of the gallery',
              'Variants: options, SKU, price and inventory per row',
              'The lifecycle controls — publish, archive, trash, restore',
              'Deferred deliberately this session: in-depth viewing and editing',
            ]}
          />
        ),
      },

      /* ── customers, discounts ────────────────────────────────────────── */
      { path: '/customers', element: <Customers /> },
      { path: '/discounts', element: <Discounts /> },
      { path: '/discounts/new', element: <DiscountNew /> },

      /* ── content ─────────────────────────────────────────────────────── */
      { path: '/content', element: <Navigate to="/content/posts" replace /> },
      { path: '/content/posts', element: <Posts /> },
      {
        path: '/content/posts/:id',
        element: (
          <Soon
            title="Editor"
            icon={<FileText />}
            what="The editor is the TipTap writing surface, with autosave and revisions."
            todos={[
              'The editor itself — it is a large, frozen v1 component',
              'Cover image, excerpt, category and tags',
              'Publish, unpublish, archive and the revision history',
              'Decide whether v2 restyles it or embeds it as-is',
            ]}
          />
        ),
      },
      {
        path: '/content/featured',
        element: (
          <Soon
            title="Featured"
            icon={<Star />}
            what="Featured is the curated rail the storefront shows first."
            todos={[
              'The ordered rail with drag-to-reorder',
              'Adding and removing a post',
              'The read-only view a writer sees',
            ]}
          />
        ),
      },
      {
        path: '/content/banners',
        element: (
          <Soon
            title="Banners"
            icon={<LayoutTemplate />}
            what="Banners are the promotional strips at the top of the storefront."
            todos={[
              'The banner list with draft, live and archived states',
              'The editor, with its CTA pair',
              'Scheduling a banner window',
            ]}
          />
        ),
      },

      /* ── sections with no v2 screen at all yet ───────────────────────── */
      {
        path: '/marketing',
        element: (
          <Soon
            title="Marketing"
            icon={<Megaphone />}
            what="Marketing is the points programme, the ledger and the reward settings."
            todos={[
              'The overview tiles and the oldest open returns',
              'Programmes, and the rename-safe key that ledger rows point at',
              'The points ledger per customer',
              'Redemption settings: rate, minimum, and the cart cap',
            ]}
          />
        ),
      },
      {
        path: '/emails',
        element: (
          <Soon
            title="Emails"
            icon={<Mail />}
            what="Emails is the template set, the broadcasts and the subscriber list."
            todos={[
              'Templates, with the variables each one accepts',
              'Broadcasts and their send state',
              'Subscribers, and unsubscribes',
              'Surfacing stuck intents — mail that is out of retries',
            ]}
          />
        ),
      },
      {
        path: '/analytics',
        element: (
          <Soon
            title="Analytics"
            icon={<BarChart3 />}
            what="Analytics is the reporting surface the per-screen summary bars only hint at."
            todos={[
              'Revenue over a real daily series, not three cumulative windows',
              'Orders by status over time',
              'Best sellers, and what never sells',
              'A date-range picker the analytics bars can share',
            ]}
          />
        ),
      },
      {
        path: '/settings',
        element: (
          <Soon
            title="Settings"
            icon={<Settings />}
            what="Settings is the store profile, the team, shipping zones and the brand."
            todos={[
              'Store profile and the brand accent',
              'Team members and invites',
              'Shipping zones — exactly one fallback zone must exist',
              'Tax rate, which is 0 and unconfirmed against Nigerian VAT',
            ]}
          />
        ),
      },

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
