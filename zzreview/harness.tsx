/* SCRATCH REVIEW HARNESS — delete with the zzreview/ directory. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/prose.css';
import '../src/components/sidebar.css';
import { ToastProvider } from '../src/components/Toast';
import { TooltipProvider } from '../src/components/ui/Switch';
import { initSession } from '../src/data/session';
import ShopOrders from '../src/routes/ShopOrders';
import LIVE from '../src/routes/__fixtures__/orders-live.json';

const qs = new URLSearchParams(location.search);
const SCEN = qs.get('scen') ?? 'big';
const THEME = qs.get('theme');
if (THEME === 'dark' || THEME === 'light') document.documentElement.setAttribute('data-theme', THEME);

const DAY = 86_400_000;
const NOW = Date.now();

type Any = Record<string, unknown>;

const NAMES = [
  'Adaeze Nwachukwu',
  'Chukwuemeka Obiajulu Nwosu-Adegoke',
  'Bilkisu Mohammed',
  'Tunde A.',
  'Oluwaseun Ayodele Babatunde Ogunlesi-Fashola',
  'Ngozi Eze',
  'Ibrahim Sanusi',
  'Folake Adeyemi',
  'Chidinma Okonkwo',
  'Yusuf Danjuma',
  'Amaka Uzoma',
  'Emeka O.',
];
const PLACES: { city: string; region: string | null; country: string }[] = [
  { city: 'Abuja', region: 'Abuja', country: 'NG' },
  { city: 'Abuja', region: 'Federal Capital Territory', country: 'NG' },
  { city: 'Abuja', region: 'FCT', country: 'NG' },
  { city: 'Lagos', region: 'Lagos', country: 'NG' },
  { city: 'Ikeja', region: 'Lagos', country: 'NG' },
  { city: 'Ibadan', region: 'Oyo', country: 'NG' },
  { city: 'Kano', region: 'Kano', country: 'NG' },
  { city: 'Port Harcourt', region: 'Rivers', country: 'NG' },
  { city: 'Enugu', region: null, country: 'NG' },
  { city: 'Nowhereton', region: 'Wakanda', country: 'NG' },
  { city: 'London', region: 'Greater London', country: 'GB' },
  { city: 'Warri', region: '', country: 'NG' },
];
const CURRENCIES = ['NGN', 'NGN', 'NGN', 'NGN', 'NGN', 'USD', 'GBP'];
const TITLES = [
  'PLA Filament',
  'PETG Filament — Translucent Blue',
  'Nozzle set, 0.4 mm brass, five-pack',
  'Build plate adhesive',
  'ABS Filament',
];

function addr(i: number): Any | null {
  if (i % 17 === 5) return null;
  const p = PLACES[i % PLACES.length];
  return {
    city: p.city,
    name: NAMES[i % NAMES.length],
    line1: `${i + 1} Some Road`,
    line2: null,
    phone: null,
    region: p.region,
    postalCode: null,
    countryCode: p.country,
  };
}

function line(i: number, k: number, qty: number, fulfilled: number): Any {
  return {
    id: `oln_${i}_${k}`,
    lineNo: k,
    variantId: `var_${i}_${k}`,
    sku: `SKU-${i}-${k}`,
    title: TITLES[(i + k) % TITLES.length],
    optionValues: { Colour: 'Black', Weight: '1 kg' },
    qty,
    unitAmount: 2300000,
    lineTotal: 2300000 * qty,
    fulfilledQty: fulfilled,
  };
}

/** Lanes in the order they should be filled, weighted so to_pack gets 60+. */
function makeRow(i: number, lane: string): Any {
  const currency = CURRENCIES[i % CURRENCIES.length];
  const ageDays = [0, 0.4, 1.2, 2.1, 4.3, 9.7, 0.1, 3.5][i % 8];
  const paidAt = NOW - ageDays * DAY;
  const base: Any = {
    id: `ord_${lane}_${i}`,
    orderNumber: `2026-${String(100 + i).padStart(6, '0')}-S`,
    customerId: `cus_${i}`,
    email: `customer${i}@example.com`,
    currency,
    subtotal: 2300000,
    shippingTotal: 300000,
    taxTotal: 0,
    grandTotal: 2600000 + i * 1000,
    refundedTotal: 0,
    status: 'paid',
    shippingAddress: addr(i),
    billingAddress: addr(i),
    placedAt: paidAt - 1000,
    paidAt,
    fulfilledAt: null,
    cancelledAt: null,
    revision: 2,
    checkoutId: `crt_${i}`,
    paymentIntentId: `pi_${i}`,
  };
  let lines: Any[] = [line(i, 0, 2, 0), line(i, 1, 1, 0)];

  if (lane === 'awaiting_payment') {
    base.status = 'pending';
    base.paidAt = null;
  } else if (lane === 'to_pack') {
    base.status = 'paid';
  } else if (lane === 'packing') {
    base.status = 'paid';
    lines = [line(i, 0, 3, 1), line(i, 1, 2, 0)];
  } else if (lane === 'check_parcel') {
    base.status = 'partially_refunded';
    base.refundedTotal = 500000;
    lines = [line(i, 0, 2, 2), line(i, 1, 1, 1)];
  } else if (lane === 'shipped') {
    base.status = 'fulfilled';
    base.fulfilledAt = paidAt + DAY;
    lines = [line(i, 0, 2, 2)];
  } else if (lane === 'closed') {
    base.status = i % 2 === 0 ? 'cancelled' : 'refunded';
    base.cancelledAt = paidAt + 1000;
    base.refundedTotal = i % 2 === 0 ? 0 : base.grandTotal as number;
  } else if (lane === 'needs_attention') {
    base.status = 'paid';
    lines = [line(i, 0, 2, 0)];
    (lines[0] as Any).qty = 'two'; // unreadable line -> needs_attention
  }
  return { order: base, lines };
}

function bigSet(): Any[] {
  const plan: [string, number][] = [
    ['awaiting_payment', 6],
    ['to_pack', 62],
    ['packing', 9],
    ['check_parcel', 3],
    ['shipped', 11],
    ['closed', 5],
    ['needs_attention', 2],
  ];
  const out: Any[] = [];
  let i = 0;
  for (const [lane, n] of plan) {
    for (let k = 0; k < n; k += 1) out.push(makeRow(i++, lane));
  }
  return out;
}

function oneEachSet(): Any[] {
  // One card in every lane except an empty one, for the "empty lane" look.
  const lanes = ['awaiting_payment', 'to_pack', 'packing', 'shipped'];
  return lanes.map((lane, k) => makeRow(k, lane));
}

const ZONES = [
  {
    id: 'zone_abuja',
    label: 'Abuja',
    countries: ['NG'],
    regions: ['Abuja', 'FCT', 'Federal Capital Territory'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 0,
    options: [
      { id: 'o1', zoneId: 'zone_abuja', label: 'Standard delivery', amountMinor: 300000, estimate: '', position: 0 },
    ],
  },
  {
    id: 'zone_lagos',
    label: 'Lagos',
    countries: ['NG'],
    regions: ['Lagos'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 1,
    options: [
      { id: 'o2', zoneId: 'zone_lagos', label: 'Standard delivery', amountMinor: 1000000, estimate: '', position: 0 },
    ],
  },
  {
    id: 'zone_rest',
    label: 'Rest of Nigeria',
    countries: ['NG'],
    regions: [],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: true,
    position: 2,
    options: [
      { id: 'o3', zoneId: 'zone_rest', label: 'Standard delivery', amountMinor: 1000000, estimate: '', position: 0 },
    ],
  },
];

const ROWS: Any[] =
  SCEN === 'live'
    ? (LIVE as Any).items as Any[]
    : SCEN === 'empty'
      ? []
      : SCEN === 'one'
        ? oneEachSet()
        : bigSet();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();

  if (url.includes('/api/auth/me')) {
    return json({ user: { id: 'u_1', email: 'owner@plaspool.test', displayName: 'The Owner', role: 'owner' } });
  }
  if (url.includes('/api/shop/admin/shipping-zones')) {
    if (SCEN === 'nozones') return json({ error: 'nope' }, 500);
    return json({ items: ZONES });
  }
  if (/\/api\/shop\/admin\/orders\/[^/?]+$/.test(url) && method === 'GET') {
    const id = url.split('/').pop()!.split('?')[0];
    const row = ROWS.find((r) => (r.order as Any).id === id) ?? ROWS[0];
    return json({ order: row.order, lines: row.lines, fulfillments: [], payments: [], refunds: [] });
  }
  if (url.includes('/api/shop/admin/orders')) {
    if (method === 'POST') {
      if (SCEN === 'failmove') return json({ error: 'conflict', message: 'stale' }, 409);
      return json({ ok: true, id: 'ful_1' });
    }
    if (SCEN === 'loading') return new Promise<Response>(() => {});
    return json({ items: ROWS, nextCursor: SCEN === 'big' ? 'cur_2' : null });
  }
  if (url.includes('/api/shop/admin/fulfillments')) {
    if (SCEN === 'failmove') return json({ error: 'conflict' }, 409);
    return json({ ok: true });
  }
  if (url.includes('/api/')) return json({ items: [] });
  return real(input as RequestInfo, init);
};

const router = createHashRouter([
  { path: '/shop/orders', element: <ShopOrders /> },
  { path: '*', element: <ShopOrders /> },
]);

void initSession().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <TooltipProvider>
        <ToastProvider>
          <div className="shell">
            <div className="shell__main">
              <RouterProvider router={router} />
            </div>
          </div>
        </ToastProvider>
      </TooltipProvider>
    </StrictMode>,
  );
});
