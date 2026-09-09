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
  fez: 'One courier across Nigeria. Prices delivery at checkout by state and weight, rounded up to the next ₦1,000, and picks up from your address.',
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
    shipFromHint: "Where the courier collects parcels. Terminal Africa needs it. Fez can price without it, using your Fez account address — but until you fill in the state, Fez won't tell shoppers how long delivery takes.",
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
    /**
     * TEST THIS COURIER — four buttons that replace four throwaway scripts.
     *
     * Each sentence here has to survive being read by somebody holding a
     * parcel and a phone, so every one of them says what the button DOES and,
     * where it matters, what it does not: nothing in this panel books
     * anything or spends money, and the panel is worthless if an operator
     * hesitates over that.
     *
     * The price check is the one that earns the panel. Terminal accepts 46
     * cities in Lagos and 10 in Abuja and refuses every other name, so a real
     * Abuja order is usually refused — and the only way to discover the list
     * was to fail a live booking. `accepted` introduces the names it offered.
     */
    diagnostics: {
      title: 'Test this courier',
      hint: 'Four questions worth asking before a real parcel depends on the answers. Nothing here books anything or spends money.',
      connection: 'Check the connection',
      connectionHint: 'Whether the credentials on this server still work.',
      quote: 'Ask for a test price',
      quoteHint: 'A made-up delivery address, priced from the ship-from address above. Nothing is booked.',
      selfTest: 'Send a test update to this admin',
      selfTestHint: 'Signs an update the way this courier signs one and posts it at our own address, to prove the shop can hear back.',
      simulate: 'Ask the courier to send one',
      simulateHint: 'Ask for a test price first — this needs the draft that a price creates.',
      /** Names each outcome region. Four live regions all called "result" are four regions called nothing. */
      outcome: (name: string) => `${name} — result`,
      accepted: 'It will accept these instead:',
      addressLine: 'Test address line',
      city: 'Test city',
      region: 'Test state',
      postalCode: 'Test postal code',
      weight: 'Test weight in grams',
      weightHint: 'Leave blank for 1 kg.',
      addressIncomplete: 'An address line, a city and a state, please — that is what the courier prices.',
      weightInvalid: 'Weight is grams — a whole number above 0.',
      /* Both halves of the simulation, always, because they disagree: Terminal
         answers "queued" and its own log then says nothing was delivered, and
         either half alone reads as the opposite of the truth. */
      simulateAsked: 'Asked to send one',
      simulateLog: 'Their own delivery log',
      simulateSilent: 'nothing at all',
      legOk: 'Yes',
      legBad: 'No',
      /* Not an outcome — a request that could not be run. The fields it is
         about are on this same screen, and they are marked when this shows. */
      shipFromIncomplete: 'The courier prices from your ship-from address, and it is not complete. Fill in the fields marked above, save, then ask again.',
      failed: 'Couldn’t ask the courier — try again.',
      /**
       * REFRESH PLACE LISTS — the one button on this screen that fills a cache
       * everything else reads.
       *
       * Terminal checks the state AND the city against its own lists and
       * refuses anything else outright, so until the list has been fetched
       * there is nothing to offer a shopper at checkout and nothing to offer
       * staff when a booking is refused. It costs one call plus one per state,
       * which is fine for somebody pressing a button and impossible inside a
       * checkout — so it is a button, and it answers in counts rather than
       * succeeding silently.
       */
      refreshPlaces: 'Refresh place lists',
      refreshPlacesHint: 'Ask this courier which states and places it will accept, and keep the answer. Those are the names a shopper picks from at checkout, and the ones offered here when a courier will not recognise an address.',
      /* A courier with no city list is not a smaller answer, it is a different
         one — it means a shopper may type whatever they like below the state,
         and saying "0 places" would read as "nowhere is acceptable". */
      placesRefreshed: (label: string, regions: number, cities: number) =>
        cities === 0
          ? `${label} listed ${regions} state${regions === 1 ? '' : 's'}, and checks no place names below them.`
          : `${label} listed ${regions} state${regions === 1 ? '' : 's'} and ${cities} place${cities === 1 ? '' : 's'} inside them.`,
      placesUnsupported: (label: string) => `${label} does not publish a list of places, so there is nothing to keep.`,
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
    /** `POST …/courier/refresh` answers `changed: false, transitioned: null`
     *  when the courier had nothing new to say — this is that toast, so a
     *  press of the button never looks identical to one that moved nothing. */
    refreshedNoChange: 'Nothing new from the courier yet',
    courierCancelled: (index: number) => `Parcel ${index} courier cancelled`,
    cost: (amount: string) => `Cost ${amount}`,
    lastError: (msg: string) => `Courier problem: ${msg}`,
    /**
     * SEND OUT ITEMS, WITH A COURIER SWITCHED ON — the sentence that replaces
     * the Carrier and Tracking number boxes.
     *
     * Packing and booking are two steps and the buttons for them live on two
     * screens: Book sits on a PARCEL ROW, which does not exist until this
     * modal has been through. Without this line the modal reads as the whole
     * job, and the boxes it used to show invited an operator to type a carrier
     * seconds before the courier filled that same field in itself.
     *
     * Carries the part-shipment fact the old line carried, because that is
     * still what the quantity boxes are for.
     */
    packFirst: (label: string) =>
      `Pack the items into a parcel first — whatever is left stays open for the next one. You'll book ${label} for it on the next screen.`,
  },
  dialog: {
    title: (label: string, index: number) => `Book Parcel ${index} with ${label}`,
    quoting: 'Asking the courier for a price…',
    weightsTitle: 'Weights first',
    weightsBlocking: 'Terminal Africa needs a weight for every item in this parcel. Set them here — they are saved on the product.',
    /**
     * THE SAME GATE, FOR SOMEBODY WHO CANNOT OPEN IT.
     *
     * A weight is saved on the VARIANT, which is the `products` domain, while
     * booking a courier is `orders` — so Support and Marketing reach this step
     * with no way past it. Names the one thing they can do (hand it on) rather
     * than offering boxes whose Save the server would 403.
     */
    weightsNoPermission:
      'Terminal Africa needs a weight for every item below, and a weight is saved on the product — which your role cannot edit. Ask somebody who can edit products to weigh these, then book this parcel again.',
    weightsSoft: (n: number, kg: number) =>
      `${n} item${n === 1 ? ' has' : 's have'} no weight. Fez will be told ${kg} kg. You can set weights now or book anyway.`,
    /**
     * THE SAME WARNING, FOR SOMEBODY WHO CANNOT ACT ON IT.
     *
     * `weightsSoft` invites the viewer to "set weights now" — wrong for a
     * teammate whose role cannot PATCH a variant. Book is still live on this
     * path (Fez does not need the weight to book, unlike Terminal's gate), so
     * this only redirects who does the weighing.
     */
    weightsSoftNoPermission: (carrier: string, kg: number) =>
      `Someone who can edit products has to set these weights. You can book anyway — ${carrier} will be told ${kg} kg.`,
    weightLabel: (title: string) => `Weight of ${title}`,
    saveWeights: 'Save weights',
    weightsInvalid: 'Weight is grams — a whole number above 0.',
    optionsTitle: 'Pick a delivery',
    optionsOne: 'Price',
    optionsEmpty: 'The courier returned no options for this address.',
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE COURIER WILL NOT RECOGNISE THE CITY, AND IT NAMED THE ONES IT WOULD.
     *
     * Terminal accepts ten place names in the whole FCT — "Maitama" is one,
     * "Gwarinpa" is not — and every order placed before the checkout learned to
     * ask for a zone carries no zone at all. That was a dead end: a refusal in
     * the courier's own words and nothing to press.
     *
     * The copy has one job beyond naming the list: to say plainly that
     * PICKING ONE DOES NOT REWRITE THE CUSTOMER'S ADDRESS. Somebody choosing
     * "Maitama" for a parcel going to Gwarinpa needs to know they are naming a
     * delivery area for the courier and not correcting where a person lives —
     * otherwise the honest ones will hesitate and the rest will assume the
     * worst has already happened.
     * ═══════════════════════════════════════════════════════════════════════
     */
    zoneTitle: 'This courier does not know that city',
    zoneAsk: 'Pick the closest place it does know. That is the delivery area the courier is given for this parcel — the address on the order stays exactly as the customer wrote it.',
    zoneCustomer: (city: string) => `The customer wrote ${city}.`,
    /** Names the row of choices, so a screen reader reaches a group rather than
     *  a loose handful of buttons in the middle of a dialog. */
    zoneLegend: 'Delivery zone',
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
    /* A 403 that reached the screen anyway. `forbidden` is the server's word,
       not a sentence, and this dialog spans two permission domains — so the
       code was reachable by a person rather than only by a bug. */
    forbidden: 'Your role cannot make that change. Ask an owner or a developer.',
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
