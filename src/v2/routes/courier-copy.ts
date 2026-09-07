import type { CourierProviderId, CourierState } from '../../data/api-shop';
import type { BadgeTone } from '../ui/primitives';

export type { CourierProviderId, CourierState };

/** The admin's words for each courier choice (CLAUDE.md §7: plain, name the thing). */
export const PROVIDER_LABEL: Record<CourierProviderId, string> = {
  manual: 'By hand',
  fez: 'Fez Delivery',
  terminal: 'Terminal Africa',
};

export const PROVIDER_BLURB: Record<CourierProviderId, string> = {
  manual: 'You type the carrier and tracking number yourself when a parcel goes out.',
  fez: 'One courier across Nigeria. Priced by state and weight; picks up from your address.',
  terminal: 'Many couriers behind one account — GIG, Kwik, DHL and more. Needs a weight on every item and a complete ship-from address.',
};

/** Which env vars a provider needs on the server — shown when a card is switched off. */
export const PROVIDER_ENV: Record<'fez' | 'terminal', string> = {
  fez: 'FEZ_USER_ID, FEZ_PASSWORD and FEZ_SECRET_KEY',
  terminal: 'TERMINAL_SECRET_KEY',
};

/**
 * The ONE variable each courier signs its webhooks with — the half of
 * `PROVIDER_ENV` that decides whether statuses can come back at all. Fez books
 * on two other credentials entirely, so it can be `configured` without this.
 */
export const PROVIDER_WEBHOOK_ENV: Record<'fez' | 'terminal', string> = {
  fez: 'FEZ_SECRET_KEY',
  terminal: 'TERMINAL_SECRET_KEY',
};

export const COURIER_COPY = {
  settings: {
    title: 'Delivery courier',
    subtitle: 'Who carries parcels to customers, and where they collect them from.',
    choiceLegend: 'Courier',
    notSetUp: (env: string) => `Not set up on this server — add ${env}, then redeploy.`,
    envLine: (environment: 'sandbox' | 'live') => (environment === 'live' ? 'Live' : 'Sandbox'),
    connected: 'connected',
    /**
     * BOOKABLE BUT DEAF. Says which half works, which half does not, and the
     * exact variable that fixes it — the only action available, and it is a
     * deploy rather than anything on this screen.
     */
    webhookNotReady: (p: 'fez' | 'terminal') =>
      `Bookings will work, but ${p === 'fez' ? 'Fez' : 'Terminal'} cannot send status updates until ${PROVIDER_WEBHOOK_ENV[p]} is set on this server.`,
    shipFromTitle: 'Ship-from address',
    shipFromHint: 'Where the courier collects parcels. Required for Terminal Africa; Fez uses the address on your Fez account unless you fill this in.',
    packagingTitle: 'Packaging',
    packagingHint: 'The box Terminal quotes against. Change it if your parcels are usually a different size.',
    webhooksTitle: 'Courier updates',
    webhooksHint: 'Each courier tells this admin when a parcel moves. Press Connect once per courier; the address below is what they call.',
    connect: 'Connect webhook',
    connected_toast: (label: string) => `${label} will now send updates here`,
    recentTitle: 'Recent courier updates',
    recentEmpty: 'Nothing received yet.',
    save: 'Save',
    saved: 'Delivery courier saved',
    conflict: 'Someone else changed this — reload and try again.',
    shipFromIncomplete: 'Fill in the ship-from address before switching to Terminal Africa.',
    onlyOwners: 'Only the owner and developers can change this',
    onlyOwnersBody: 'The courier books real pickups and spends real money, so only the owner and developers can change it.',
    terminalModal: {
      title: 'Before you switch on Terminal Africa',
      intro: 'Terminal books real couriers and charges your Terminal wallet.',
      weights: (missing: number, total: number) =>
        missing === 0
          ? 'Every product variant has a weight.'
          : `Every product variant needs a weight. ${missing} of ${total} have none — you won't be able to book a parcel that contains them until they do.`,
      shipFrom: 'Your ship-from address must be complete (checked when you save).',
      wallet: 'Your Terminal wallet must have money in it.',
      webhook: 'Statuses come back by webhook — press Connect webhook after saving.',
      cancel: 'Cancel',
      confirm: 'Switch to Terminal',
    },
  },
  parcel: {
    book: (label: string) => `Book with ${label}`,
    bookAgain: 'Book again',
    shipByHand: 'Ship by hand',
    waybill: 'Waybill',
    refresh: 'Refresh status',
    cancelCourier: 'Cancel courier',
    /* The two toasts the parcel row raises, in the same shape as its existing
       ones ("Parcel 1 shipped", "Parcel 1 tracking saved"). */
    refreshed: (index: number) => `Parcel ${index} status refreshed`,
    courierCancelled: (index: number) => `Parcel ${index} courier cancelled`,
    cost: (amount: string) => `Cost ${amount}`,
    lastError: (msg: string) => `Courier problem: ${msg}`,
  },
  dialog: {
    title: (label: string, index: number) => `Book Parcel ${index} with ${label}`,
    quoting: 'Asking the courier for a price…',
    weightsTitle: 'Weights first',
    weightsBlocking: 'Terminal Africa needs a weight for every item in this parcel. Set them here — they are saved on the product.',
    weightsSoft: (n: number, kg: number) =>
      `${n} item${n === 1 ? ' has' : 's have'} no weight. Fez will be told ${kg} kg. You can set weights now or book anyway.`,
    weightLabel: (title: string) => `Weight of ${title}`,
    saveWeights: 'Save weights',
    weightsInvalid: 'Weight is grams — a whole number above 0.',
    optionsTitle: 'Pick a delivery',
    optionsOne: 'Price',
    optionsEmpty: 'The courier returned no options for this address.',
    confirmTitle: 'Confirm booking',
    recipient: 'To',
    weight: (kg: number) => `${kg} kg`,
    bookNow: 'Book',
    booked: (label: string, ref: string) => `Booked with ${label} · ${ref}`,
    notConfigured: (env: string) => `This courier isn't set up on the server yet. Add ${env}, then redeploy.`,
    rejected: (label: string, msg: string) => `${label} said: ${msg}`,
    unavailable: (label: string) => `${label} didn't answer. Try again in a minute.`,
    alreadyBooked: 'This parcel already has a courier. Reloading.',
    /* The cancel button lost a race with the courier's own webhook. Says what
       happened and what to press next, because "already_shipped" says neither.
       Lives beside `alreadyBooked` because `describeCourierError` is the one
       reader of both, and it reads every other sentence from this table. */
    alreadyShipped: 'This parcel has already gone out. Refresh to see where it is.',
    manual: 'Courier booking is switched off. Turn it on under Settings → Delivery courier.',
  },
} as const;

const STATE_BADGE: Record<CourierState, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Quoted', tone: 'neutral' },
  booked: { label: 'Booked', tone: 'info' },
  picked_up: { label: 'Picked up', tone: 'info' },
  in_transit: { label: 'On its way', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'ok' },
  returned: { label: 'Returned', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'warn' },
  failed: { label: 'Failed', tone: 'critical' },
  unknown: { label: 'Unknown', tone: 'warn' },
};

export function courierStateBadge(state: CourierState | null | undefined): { label: string; tone: BadgeTone } | null {
  return state ? STATE_BADGE[state] : null;
}

/** States from which a parcel may be (re)booked. Mirrors the server guard. */
export function canBook(state: CourierState | null | undefined): boolean {
  return state == null || state === 'draft' || state === 'cancelled' || state === 'failed' || state === 'returned';
}
