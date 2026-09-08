import { useEffect, useMemo, useState } from 'react';
import { Send, UserRound, Users } from 'lucide-react';
import { shopApi, type ProspectTab, type ShopProspect, type SubscribeState } from '../../data/api-shop';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { useAsync } from '../lib/useAsync';
import { money, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { PeopleArt } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type BulkConfig, type Column } from '../ui/DataTable';

/**
 * NOT BOUGHT YET — `/customers/not-bought`.
 *
 * The other half of Customers: everybody we have an address for who has never
 * placed an order. One row per folded email address, and the four tabs are
 * DISJOINT with `Everyone` as their union — somebody with a basket and an
 * account is one row carrying two chips, on the basket tab, and not two rows.
 * `server/shop/admin/prospects.ts` owns that definition; this screen only
 * names it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `unreachableBaskets` IS A FACT ABOUT THE SHOP AND NOT ABOUT THIS PAGE, so it
 * is worded as one.
 *
 * It counts carts that hold goods and resolve to no email address at all — 13
 * of 19 on production the day this shipped — and the server deliberately does
 * not move it with the tab, the cursor or the search box. Printed as a bare
 * "13 baskets we can't reach" it would therefore sit beside zero baskets on
 * the Subscribers tab and read as a lie about what is on screen. Two things
 * fix that, and both are load-bearing:
 *
 *  - the word **shop-wide**, which is the whole disambiguation and costs one
 *    word, and
 *  - **email address** rather than "address", because on a commerce screen a
 *    bare "no address" reads as a missing delivery address.
 *
 * It goes in the SUBTITLE and not only in the analytics bar, because the bar
 * starts hidden (`Page.tsx`, Rule 1) — a number nobody has opened a menu to
 * reveal is not a visible number, and the reason this count exists at all is
 * that a screen listing 6 people and saying nothing else implies 6 is the
 * whole picture. The sentence disappears when the count is zero, so it is
 * present exactly while the shop has the problem it describes.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TABS: { value: ProspectTab; label: string }[] = [
  { value: 'basket', label: 'Has a basket' },
  { value: 'account', label: 'Made an account' },
  { value: 'subscriber', label: 'Subscribers' },
  { value: 'all', label: 'Everyone' },
];

/**
 * Can we write to them, and have we asked? Three states rather than a boolean:
 * an address somebody added by hand is mailable and has never consented, which
 * is a different thing from one that opted out.
 */
const SUBSCRIBE: Record<SubscribeState, { label: string; tone: BadgeTone }> = {
  subscribed: { label: 'Subscribed', tone: 'ok' },
  never_asked: { label: 'Never asked', tone: 'neutral' },
  unsubscribed: { label: 'Unsubscribed', tone: 'critical' },
};

/** Each tab's own nothing-here, because "No results" on four different
 *  populations tells the reader nothing about which one is empty. */
const NOTHING: Record<ProspectTab, { title: string; body: string }> = {
  basket: {
    title: 'No baskets waiting',
    body: 'A basket lands here once we have an email address for whoever left it.',
  },
  account: {
    title: 'No accounts waiting',
    body: 'A new account sits here until it orders. Put something in a basket and it moves to Has a basket.',
  },
  subscriber: {
    title: 'No subscribers left over',
    body: 'Anyone the other two tabs already cover is listed there instead, and people who have bought are on Customers.',
  },
  all: {
    title: 'Nobody has stopped short yet',
    body: 'Baskets left behind, new accounts and subscribers all land here — until they order.',
  },
};

export default function NotBought() {
  const [shown, toggle] = useAnalyticsBar('not-bought');

  /* THE GATE IS THE DOMAIN, NEVER A ROLE NAME — `EmailBroadcasts.tsx` says
     why. The list itself is `/api/shop/admin/customers/…`, which `customers`
     already covers, so support reads the screen; only the send is marketing's,
     and it is ABSENT rather than disabled, because the server would answer 403
     and a disabled button is a promise nobody can keep. */
  const session = getSession();
  const role = 'user' in session ? session.user?.role : undefined;
  const canSend = role !== undefined && hasDomain(role, 'marketing');

  const [tab, setTab] = useState<ProspectTab>('basket');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  /* Task 11 mounts the composer against this. The pill records WHO was picked
     and nothing else until then; the handler is deliberately without a visible
     effect for one task rather than being a second, throwaway modal. */
  const [, setSending] = useState<string[] | null>(null);

  /** Back to page one — a cursor measured against the old list is meaningless
   *  the moment the tab or the search changes. Identity-stable when it is
   *  already page one, so a keystroke does not re-render the table. */
  function resetPage() {
    setCursors((was) => (was.length === 1 && was[0] === null ? was : [null]));
  }

  const onSearch = (next: string) => {
    setSearch(next);
    resetPage();
  };

  /* THE SEARCH IS THE SERVER'S, and it has to be: a page is 25 rows out of a
     list this screen exists to work through, so filtering those 25 in the
     browser would answer "nobody matches" for somebody who is simply on page
     three. Debounced a beat — the same 220ms the palette's live customer
     search uses — so typing is one request rather than one per keystroke. */
  useEffect(() => {
    const next = search.trim();
    if (next === term) return;
    const timer = window.setTimeout(() => setTerm(next), 220);
    return () => window.clearTimeout(timer);
  }, [search, term]);

  const { data, error, loading } = useAsync(
    (signal) =>
      shopApi.listProspects(
        {
          tab,
          ...(cursor ? { cursor } : {}),
          limit: 25,
          ...(term ? { query: term } : {}),
        },
        signal,
      ),
    [tab, cursor, term],
  );

  const rows = data?.items ?? [];
  const unreachable = data?.unreachableBaskets ?? 0;

  /**
   * EVERY CELL HERE IS ABOUT THIS PAGE, and `unreachableBaskets` is
   * deliberately NOT among them.
   *
   * `AnalyticsBar` prints its `range` as the bar's first cell — "This page" —
   * so the bar states its own scope, and a shop-wide count sitting inside it
   * contradicts the label it is standing next to. That number belongs in the
   * header sentence instead, where it can say "shop-wide" out loud and where
   * it is on screen without anybody opening a menu.
   */
  const metrics: Metric[] = useMemo(() => {
    const baskets = rows.filter((p) => p.basketItems > 0);
    /* Off the first row that HAS a basket: `currency` is empty by design for
       somebody with none, and `safeFormatMinor` renders an empty code as
       unrenderable rather than guessing. */
    const currency = baskets.find((p) => p.currency)?.currency ?? 'NGN';
    return [
      { label: 'People on this page', value: String(rows.length) },
      { label: 'Baskets we can reach', value: String(baskets.length) },
      {
        label: 'What they’re worth',
        value: money(
          baskets.reduce((sum, p) => sum + p.basketMinor, 0),
          currency,
        ),
      },
      {
        label: 'Never asked to subscribe',
        value: String(rows.filter((p) => p.subscribeState === 'never_asked').length),
      },
    ];
  }, [rows]);

  const columns: Column<ShopProspect>[] = [
    {
      key: 'person',
      header: 'Person',
      primary: true,
      render: (p) => (
        <IdCell
          thumb={<UserRound aria-hidden="true" />}
          title={p.displayName || p.email}
          meta={p.displayName ? p.email : undefined}
        />
      ),
    },
    {
      key: 'known',
      header: 'What we know',
      label: 'What we know',
      render: (p) => (
        <span className="row" style={{ flexWrap: 'wrap' }}>
          {p.hasBasket ? <Badge tone="info">Basket</Badge> : null}
          {p.hasAccount ? <Badge>Account</Badge> : null}
          {p.isSubscriber ? <Badge>Subscriber</Badge> : null}
        </span>
      ),
    },
    {
      key: 'basket',
      mobile: 'keep',
      header: 'Basket',
      label: 'Basket',
      /* BLANK rather than "0 items · ₦0" when there is none: a zero in a money
         column reads as a basket worth nothing, which is not the same fact as
         no basket at all. */
      render: (p) =>
        p.basketItems > 0 ? (
          <span className="row">
            <span>
              {p.basketItems} {p.basketItems === 1 ? 'item' : 'items'}
            </span>
            <strong className="num">{money(p.basketMinor, p.currency)}</strong>
          </span>
        ) : null,
    },
    {
      key: 'seen',
      header: 'Last seen',
      label: 'Last seen',
      render: (p) => shortDate(p.lastSeenAt),
    },
    {
      key: 'reach',
      mobile: 'keep',
      header: 'Can we email them',
      label: 'Can we email them',
      tight: true,
      render: (p) => (
        <Badge tone={SUBSCRIBE[p.subscribeState].tone}>{SUBSCRIBE[p.subscribeState].label}</Badge>
      ),
    },
    {
      key: 'nudge',
      header: 'Last nudge',
      label: 'Last nudge',
      /* `shortDate(null)` is an em dash — nobody has been written to yet, which
         is the ordinary state of every row until the first broadcast lands. */
      render: (p) => shortDate(p.lastNudgeAt),
    },
  ];

  const bulk: BulkConfig | undefined = canSend
    ? {
        pills: [
          {
            label: 'Send an email…',
            icon: <Send aria-hidden="true" />,
            onAction: (keys) => setSending(keys),
          },
        ],
      }
    : undefined;

  const nothing = NOTHING[tab];

  return (
    <div className="page">
      <PageHeader
        icon={<Users />}
        title="Not bought yet"
        subtitle={
          'People we can reach who haven’t ordered — baskets left behind, new accounts, and subscribers.' +
          (unreachable > 0
            ? ` Shop-wide, ${unreachable === 1 ? 'one more basket holds' : `${unreachable} more baskets hold`}` +
              ' goods and no email address at all — nobody to write to.'
            : '')
        }
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load this list">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Not bought yet"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.email}
        /* THE SKELETON ON EVERY FETCH, not only the first. The four tabs are
           disjoint populations, so holding the old rows up while the next tab
           loads shows people who are, by definition, not on the tab whose name
           is now lit. */
        loading={loading}
        bulk={bulk}
        tabs={{
          value: tab,
          tabs: TABS,
          /* The cursor goes with it. A keyset cursor is a position in ONE
             tab's ordering, so carrying it across would page into a list it
             was never measured against. */
          onChange: (next) => {
            resetPage();
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Search names and email addresses',
          onChange: onSearch,
        }}
        empty={
          search.trim() ? (
            <EmptyState
              icon={<Users />}
              title="Nobody matches that search"
              body="It looks through names and email addresses on every page, not just this one."
              actions={<Button onClick={() => onSearch('')}>Clear search</Button>}
            />
          ) : (
            <EmptyState
              icon={tab === 'all' ? undefined : <Users />}
              art={tab === 'all' ? <PeopleArt /> : undefined}
              title={nothing.title}
              body={nothing.body}
            />
          )
        }
        footer={
          <TablePager
            note={`${rows.length} shown`}
            canPrev={cursors.length > 1}
            canNext={Boolean(data?.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => setCursors((c) => [...c, data?.nextCursor ?? null])}
          />
        }
      />
    </div>
  );
}
