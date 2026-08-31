/* SCRATCH — returns board above the orders board, same page, same tokens. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/routes/marketing.css';
import { ReturnsBoard } from '../src/routes/marketing/ReturnsBoard';
import { OrdersBoard } from '../src/routes/orders/Board';
import { BoardCard } from '../src/routes/orders/BoardCard';
import type { ReturnListItem } from '../src/data/api-marketing';
import type { ShopOrderRow } from '../src/data/api-shop';

const qs = new URLSearchParams(location.search);
const THEME = qs.get('theme');
if (THEME === 'dark' || THEME === 'light') document.documentElement.setAttribute('data-theme', THEME);

const NOW = Date.now();
const DAY = 86_400_000;

const program = {
  id: 'p1',
  key: 'canisters',
  kind: 'unit_return' as const,
  name: 'Canister returns',
  pointsLabelSingular: 'point',
  pointsLabelPlural: 'points',
  unitLabelSingular: 'canister',
  unitLabelPlural: 'canisters',
  minUnitsPerReturn: 1,
  pointsPerUnit: 20,
  status: 'active' as const,
  conditions: {},
  seeded: false,
};

function ret(i: number, status: string, ageDays: number, name: string | null): ReturnListItem {
  return {
    id: `r_${i}`,
    status: status as ReturnListItem['status'],
    revision: 1,
    customerEmail: `person${i}@example.com`,
    customerName: name,
    qtyDeclared: 2 + (i % 9),
    qtyAccepted: null,
    qtyRejected: null,
    pointsPerUnitSnapshot: 20,
    pointsAwarded: null,
    pickupScheduledAt: null,
    pickupAddress: null,
    allowedActions: ['schedule', 'reject', 'cancel'] as ReturnListItem['allowedActions'],
    serviceArea: { id: 'a1', name: 'Garki' },
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW,
    program: program as unknown as ReturnListItem['program'],
  };
}

const returns: ReturnListItem[] = [
  ret(1, 'requested', 0.2, 'Adaeze Nwachukwu'),
  ret(2, 'requested', 2.4, 'Chukwuemeka Obiajulu Nwosu-Adegoke'),
  ret(3, 'requested', 5.1, null),
  ret(4, 'scheduled', 1.1, 'Bilkisu Mohammed'),
  ret(5, 'scheduled', 4.4, 'Tunde A.'),
  ret(6, 'collected', 0.6, 'Ngozi Eze'),
  ret(7, 'received', 3.2, 'Ibrahim Sanusi'),
];

function order(i: number, lane: string, ageDays: number, name: string, region: string): ShopOrderRow {
  const paidAt = NOW - ageDays * DAY;
  const lines =
    lane === 'packing'
      ? [{ id: `l${i}a`, lineNo: 0, variantId: 'v', sku: 'S', title: 'PLA Filament', optionValues: {}, qty: 3, unitAmount: 2300000, lineTotal: 6900000, fulfilledQty: 1 }]
      : [{ id: `l${i}a`, lineNo: 0, variantId: 'v', sku: 'S', title: 'PLA Filament', optionValues: {}, qty: 2, unitAmount: 2300000, lineTotal: 4600000, fulfilledQty: 0 },
         { id: `l${i}b`, lineNo: 1, variantId: 'v2', sku: 'S2', title: 'Nozzle set', optionValues: {}, qty: 1, unitAmount: 300000, lineTotal: 300000, fulfilledQty: 0 }];
  return {
    order: {
      id: `o_${i}`,
      orderNumber: `2026-${String(100 + i).padStart(6, '0')}-S`,
      customerId: 'c',
      email: `p${i}@example.com`,
      currency: 'NGN',
      subtotal: 2300000,
      shippingTotal: 300000,
      taxTotal: 0,
      grandTotal: 2600000,
      refundedTotal: 0,
      status: lane === 'awaiting_payment' ? 'pending' : 'paid',
      shippingAddress: { city: region, name, line1: '1 Road', line2: null, phone: null, region, postalCode: null, countryCode: 'NG' },
      billingAddress: null,
      placedAt: paidAt - 1000,
      paidAt: lane === 'awaiting_payment' ? null : paidAt,
      fulfilledAt: null,
      cancelledAt: null,
      revision: 1,
      checkoutId: 'k',
      paymentIntentId: 'pi',
    },
    lines,
  } as unknown as ShopOrderRow;
}

const orders: ShopOrderRow[] = [
  order(1, 'awaiting_payment', 0.2, 'Adaeze Nwachukwu', 'Abuja'),
  order(2, 'to_pack', 2.4, 'Chukwuemeka Obiajulu Nwosu-Adegoke', 'Lagos'),
  order(3, 'to_pack', 5.1, 'Bilkisu Mohammed', 'Abuja'),
  order(4, 'to_pack', 0.3, 'Tunde A.', 'Kano'),
  order(5, 'packing', 4.4, 'Ngozi Eze', 'Oyo'),
  order(6, 'packing', 1.1, 'Ibrahim Sanusi', 'Rivers'),
];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ maxWidth: '76rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h2 style={{ font: '700 1rem var(--font-ui)', margin: '0 0 .5rem' }}>RETURNS BOARD (the existing one)</h2>
      <ReturnsBoard rows={returns} now={NOW} areaName="Garki" onOpen={() => {}} onLog={() => {}} />
      <h2 style={{ font: '700 1rem var(--font-ui)', margin: '2rem 0 .5rem' }}>ORDERS BOARD (the new one)</h2>
      <OrdersBoard
        rows={orders}
        now={NOW}
        renderCard={(row, lane, cardId) => (
          <BoardCard key={cardId} row={row} now={NOW} role="owner" lane={lane} expanded={false} />
        )}
      />
    </div>
  </StrictMode>,
);
