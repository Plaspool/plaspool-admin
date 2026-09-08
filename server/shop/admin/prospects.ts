import { sql, type SQL } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import type { Db } from '../../db/client';
import { encodeCursor, pageLimit, rejectNul, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import { normalizeBlobId } from '../../repo/public-projection';

/**
 * PEOPLE WHO HAVE NOT BOUGHT, and the baskets they left.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `basketFor` IS CALLED BY TWO CONSUMERS AND THAT IS THE POINT OF THIS FILE.
 *
 * The admin's person modal reads it, and so does the broadcast drain when a
 * template carries {{basket}}. One statement behind both means what an operator
 * sees when they open somebody and what that person receives in the post cannot
 * disagree. A second query written for the email would be a second answer to
 * "what is in their basket", and the two would diverge the first time either
 * changed — which nobody would notice, because the only person who sees both is
 * the recipient.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ADDRESS IS `lower(btrim(COALESCE(shop_carts.email, shop_customers.email)))`
 * AND BOTH HALVES ARE LOAD-BEARING. `shop_carts.email` is written when a shopper
 * reaches the checkout contact step (`setCheckoutContact`), so a signed-in
 * shopper who has not got that far has an address only through the customer
 * join, and a guest who HAS got that far has one only on the cart. Measured on
 * production 2026-09-08: 19 carts carried lines, 6 of them resolved to an
 * address by this expression, and 13 resolved to none at all. Those 13 are
 * counted as `unreachableBaskets` rather than listed, because a screen that
 * shows 6 and says nothing else implies 6 is the whole picture.
 *
 * PRICES COME FROM `shop_prices`, LIVE — AND NOT FROM A COLUMN ON THE VARIANT,
 * WHICH DOES NOT EXIST. `server/shop/catalog/mapping.ts`'s `VARIANT_COLUMNS`
 * names no price; `shop_prices` is effective-dated and `effective_to IS NULL`
 * is the "current" predicate, made single-valued by the partial unique index
 * `shop_prices_current_uq`. `shop_cart_lines` deliberately stores no price
 * either — `server/shop/cart/schema.ts` fails a test if one is ever added,
 * because a price on a cart line is a third source of truth that goes stale and
 * that nobody notices going stale. A basket is therefore quoted at read time
 * and is NOT a frozen total; it is what they would pay if they checked out now.
 */

// ------------------------------------------------------------------- shapes

export interface BasketLine {
  variantId: string;
  productId: string;
  /** The PRODUCT's title. A shopper recognises "PLA Basic", not a SKU. */
  title: string;
  optionValues: Record<string, string>;
  sku: string;
  qty: number;
  unitMinor: number;
  lineMinor: number;
  /** The variant's own photograph, falling back to the product cover. Normalised. */
  imageId: string | null;
}

export interface Basket {
  cartId: string;
  status: 'open' | 'converting' | 'converted' | 'abandoned';
  currency: string;
  updatedAt: number;
  expiresAt: number | null;
  lines: BasketLine[];
  totalMinor: number;
  discountCode: string | null;
  addOnChoices: unknown | null;
  redemptionPoints: number | null;
}

/**
 * One broadcast this person was queued for, newest first.
 *
 * `status` carries the four values `email_broadcast_recipients_status_ck`
 * admits since migration 0980: `pending` (queued, drain has not reached it
 * yet), `sent`, `failed`, and `skipped` — a recipient the drain refused to
 * mail, almost always because their basket had emptied by the time the batch
 * ran (`lastError: 'basket_empty'`); `'unsubscribed'` is the other value that
 * lands there.
 */
export interface Send {
  broadcastId: string;
  subject: string;
  status: string;
  sentAt: number | null;
  lastError: string | null;
}

export type ProspectTab = 'basket' | 'account' | 'subscriber' | 'all';

/**
 * Can we mail this person, and have we asked?
 *
 * THREE STATES AND NOT A BOOLEAN, because `email_subscribers` deliberately
 * keeps `consent_at` and `unsubscribed_at` apart: an address an operator added
 * has no consent timestamp and is still mailable, while `unsubscribed_at` is
 * the only thing that stops a send. `never_asked` therefore covers both an
 * address with no subscriber row at all and one whose row records no consent —
 * which is exactly the population §3.4's "Never asked to subscribe" counts.
 */
export type SubscribeState = 'subscribed' | 'never_asked' | 'unsubscribed';

export interface Prospect {
  /** The folded address. It is this row's identity, and the cursor's id. */
  email: string;
  displayName: string | null;
  hasBasket: boolean;
  hasAccount: boolean;
  /**
   * There is a row in `email_subscribers`. TRUE EVEN WHEN THEY HAVE OPTED OUT —
   * `subscribeState` beside it carries that, and hiding the chip would make an
   * unsubscribed person look like somebody we had simply never met.
   */
  isSubscriber: boolean;
  subscribeState: SubscribeState;
  /** Units in the basket, summed over its lines. Zero when there is none. */
  basketItems: number;
  /** MINOR UNITS, quoted live. Zero when there is no basket. */
  basketMinor: number;
  /**
   * What `basketMinor` is denominated in, taken from the cart. EMPTY when there
   * is no basket: a total of zero is not in a currency, and inventing the store's
   * would put a price label on a cell the screen leaves blank.
   */
  currency: string;
  /** Cart last touched, else account created, else subscribed. Never null. */
  lastSeenAt: number;
  /** When a broadcast last actually reached them, or null. */
  lastNudgeAt: number | null;
}

export interface ProspectQuery {
  tab: ProspectTab;
  cursor?: string;
  limit?: number;
  query?: string;
}

export interface ProspectPage {
  items: Prospect[];
  nextCursor: string | null;
  /**
   * Carts with lines that resolve to no address at all — 13 of 19 on production
   * the day this was written. A property of the shop rather than of the page, so
   * it does not move with the tab, the cursor or the search box.
   */
  unreachableBaskets: number;
}

// ------------------------------------------------------------------ helpers

/**
 * jsonb arrives parsed from both drivers today. Handling the string form as
 * well is the same insurance `toEpochMs` is: a PGlite/Neon divergence is
 * invisible until it is a production 500, and an option tuple silently becoming
 * the string "[object Object]" is worse than a null.
 */
function json<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ADDRESS FOLD, AND IT HAS TO BE THE SAME FIVE CHARACTERS IN SQL AND IN JS.
 *
 * `basketFor` folds a caller's string in JavaScript; every statement in this
 * file folds a stored column in SQL; and the promise at the top of the file is
 * that the address the list PRINTS reads back as the basket the list COUNTED.
 * That holds only if `foldEmail(sqlFold(x)) = sqlFold(x)` for every storable x
 * — which is to say only if the two strip exactly the same set.
 *
 * NOT ONE OF THE THREE WRITE PATHS TRIMS. `setCheckoutContact` writes
 * `a.email` verbatim, fed by `email: str().min(3).max(320)`, and `str()` strips
 * NUL and nothing else — so `' ada@example.test'` is storable on `shop_carts`,
 * on `shop_customers` and (since `lower()` of a padded address equals itself,
 * which is all `email_subscribers_email_ck` asks) on `email_subscribers` too.
 * Folding one side and not the other made the row say "1 item, ₦2,800" while
 * `basketFor` returned null, which is the exact divergence this file exists to
 * prevent.
 *
 * `btrim(x)` WITH NO SECOND ARGUMENT IS NOT THAT SET — it strips spaces and
 * nothing else, so a trailing newline off a pasted address would survive SQL
 * and not survive JS, which is the same bug one character further along. The
 * five are space, tab, CR, LF and the non-breaking space a paste out of a mail
 * client carries. `chr()` rather than an escaped literal keeps the expression
 * free of backslashes, which neither a `sql` template nor this repo's shell
 * carries reliably.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const TRIM_CODES = [32, 9, 13, 10, 160] as const;

/** The SQL half, as `chr()` calls, and the JS half, as one character class —
 *  both built from the list above so neither can drift from the other. */
const TRIM_SET = TRIM_CODES.map((code) => `chr(${code})`).join(' || ');
const TRIM_RE = ((set) => new RegExp(`^[${set}]+|[${set}]+$`, 'g'))(
  TRIM_CODES.map((code) => String.fromCharCode(code)).join(''),
);

/** `btrim(<expr>, <the five>)`. Composed into the folds below, never used bare. */
const trimSql = (expr: string): string => `btrim(${expr}, ${TRIM_SET})`;

/**
 * The JS half of the fold above. Same five characters, same order as
 * `lower(btrim(…))`, so a folded address is a fixed point of this function.
 */
function foldEmail(email: string): string {
  return email.replace(TRIM_RE, '').toLowerCase();
}

/**
 * The address a cart belongs to, as one expression, used by every statement
 * here so the list, the basket and the unreachable count cannot disagree about
 * who a cart is for.
 *
 * `NULLIF(btrim(c.email), '')` AND NOT A BARE `c.email`. `shop_carts` carries
 * no non-empty CHECK on its address (unlike `shop_customers`, which has
 * `shop_customers_email_ck`), so an empty string is storable — and a bare
 * COALESCE would let one MASK the account's real address rather than fall
 * through to it. The inner trim is what extends that to `'   '`, which is
 * otherwise a listed, mailable "prospect" whose address is whitespace: `NULLIF`
 * would not catch it, `picked`'s `email <> ''` would not catch it, and
 * `countUnreachableBaskets`'s `= ''` would not catch it either.
 */
const CART_ADDRESS = sql.raw(
  `lower(${trimSql(`COALESCE(NULLIF(${trimSql('c.email')}, ''), cu.email)`)})`,
);

/** The same fold over `shop_customers`, `email_subscribers` and `shop_orders`.
 *  One expression each, so no CTE can fold differently from its neighbours. */
const ACCOUNT_ADDRESS = sql.raw(`lower(${trimSql('cu.email')})`);
const SUB_ADDRESS = sql.raw(`lower(${trimSql('s.email')})`);
const ORDER_ADDRESS = sql.raw(`lower(${trimSql('o.email')})`);

/** A cart that could still be checked out. `converted` is an order; `abandoned`
 *  is a merged guest cart the shopper has already replaced. */
const LIVE_CART = sql.raw(`c.status IN ('open', 'converting')`);

/** …and it has to have something in it. */
const HAS_LINES = sql.raw(
  `EXISTS (SELECT 1 FROM shop_cart_lines l WHERE l.cart_id = c.id)`,
);

// ---------------------------------------------------------------- basketFor

/**
 * The one basket read. `null` when there is nothing to show — which is the
 * ORDINARY case for the drain, not an error: between the pick and the batch a
 * person may have bought, emptied their basket, or let the cart expire.
 *
 * ONE STATEMENT, joining `shop_cart_lines` → `shop_variants` → `shop_products`
 * → `shop_prices`, rather than a per-variant fan-out through
 * `CatalogPort.quote`. This is admin-side code in the same application, `quote`
 * is per variant by contract, and a basket read here is a display read rather
 * than a sale decision.
 *
 * NO EXPIRY FILTER. `shop_carts.expires_at` in the past does not empty a cart
 * or change its status, and the person modal is specified to SHOW when the cart
 * expires — so an expired basket is something to display, not something to
 * hide. `expiresAt` is on the returned shape for exactly that.
 */
export async function basketFor(db: Db, email: string): Promise<Basket | null> {
  const folded = rejectNul(foldEmail(email), 'email');
  if (folded === '') return null;

  const res = await db.execute(sql`
    WITH picked AS (
      SELECT c.id, c.status, c.currency, c.updated_at, c.expires_at,
             c.discount_code, c.add_on_choices, c.redemption_points
        FROM shop_carts c
        LEFT JOIN shop_customers cu ON cu.id = c.customer_id
       WHERE ${CART_ADDRESS} = ${folded}
         AND ${LIVE_CART}
         AND ${HAS_LINES}
       ORDER BY c.updated_at DESC, c.id ASC
       LIMIT 1
    )
    SELECT p.id AS cart_id, p.status, p.currency, p.updated_at, p.expires_at,
           p.discount_code, p.add_on_choices, p.redemption_points,
           l.variant_id, l.qty,
           v.sku, v.option_values, v.image_id,
           pr.id AS product_id, pr.title, pr.cover_image_id,
           pz.amount AS unit_minor
      FROM picked p
      JOIN shop_cart_lines l ON l.cart_id = p.id
      JOIN shop_variants   v ON v.id = l.variant_id
      JOIN shop_products  pr ON pr.id = v.product_id
      /*
       * LEFT, and the amount is coalesced to zero below. A variant with no
       * current price row is a real state rather than an error -- the same call
       * rowToVariantWithPrice makes -- and an INNER JOIN would silently drop the
       * line from the basket instead. A line showing zero is a visible defect an
       * operator can act on; a line that is simply absent is not, and it would
       * also make this answer disagree with the list's item count.
       */
      LEFT JOIN shop_prices pz ON pz.variant_id = l.variant_id
                              AND pz.effective_to IS NULL
     ORDER BY l.added_at ASC, l.id ASC`);

  const rows = res.rows;
  if (rows.length === 0) return null;

  const head = rows[0]!;
  const lines: BasketLine[] = rows.map((row) => {
    const unitMinor = row.unit_minor == null ? 0 : Number(row.unit_minor);
    const qty = Number(row.qty);
    /*
     * NORMALISED, for the reason `server/repo/public-projection.ts` gives: the
     * id is stored both bare and `asset:`/`idb:`-prefixed, and a URL built from
     * the prefixed form 404s on a live product. An empty id is dropped rather
     * than returned, because `/api/public/images/` is a different path entirely
     * rather than that route with a bad id.
     */
    const rawImage = row.image_id ?? row.cover_image_id;
    const imageId = rawImage == null ? '' : normalizeBlobId(String(rawImage));
    return {
      variantId: String(row.variant_id),
      productId: String(row.product_id),
      title: String(row.title),
      optionValues: json<Record<string, string>>(row.option_values) ?? {},
      sku: String(row.sku),
      qty,
      unitMinor,
      lineMinor: unitMinor * qty,
      imageId: imageId === '' ? null : imageId,
    };
  });

  return {
    cartId: String(head.cart_id),
    status: head.status as Basket['status'],
    currency: String(head.currency),
    updatedAt: toEpochMs(head.updated_at),
    expiresAt: toEpochMsOrNull(head.expires_at),
    lines,
    totalMinor: lines.reduce((sum, line) => sum + line.lineMinor, 0),
    discountCode: head.discount_code == null ? null : String(head.discount_code),
    addOnChoices: json<unknown>(head.add_on_choices),
    redemptionPoints:
      head.redemption_points == null ? null : Number(head.redemption_points),
  };
}

// ----------------------------------------------------------------- sendsFor

/**
 * What the shop has emailed this person, newest first, capped at 20.
 *
 * FOLDED THE SAME WAY `basketFor` FOLDS — this is the whole point of the fold
 * living in one place. `email_subscribers` is the only table here that carries
 * the address at all (`emailBroadcastRecipients` deliberately snapshots none,
 * per its own header), so a padded or mixed-case address that found a basket
 * has to find its history too, or the modal would show one without the other
 * for the exact same person.
 *
 * ORDERED BY THE BROADCAST'S `created_at`, not `sent_at` — only `sent` rows
 * carry a `sent_at` at all, and a `pending` or `skipped` row has to sort
 * sensibly among sent ones rather than collapsing to the top or bottom by
 * virtue of a null.
 */
export async function sendsFor(db: Db, email: string): Promise<Send[]> {
  const folded = rejectNul(foldEmail(email), 'email');
  if (folded === '') return [];

  const res = await db.execute(sql`
    SELECT b.id AS broadcast_id, b.subject, r.status, r.sent_at, r.last_error
      FROM email_broadcast_recipients r
      JOIN email_broadcasts b ON b.id = r.broadcast_id
      JOIN email_subscribers s ON s.id = r.subscriber_id
     WHERE ${SUB_ADDRESS} = ${folded}
     ORDER BY b.created_at DESC, r.id ASC
     LIMIT 20`);

  return res.rows.map((row) => ({
    broadcastId: String(row.broadcast_id),
    subject: String(row.subject),
    status: String(row.status),
    sentAt: toEpochMsOrNull(row.sent_at),
    lastError: row.last_error == null ? null : String(row.last_error),
  }));
}

// ------------------------------------------------------------ listProspects

/**
 * The ordering, and the cursor's sort key.
 *
 * ONE ORDERING ONLY, for the reason `listBuyers` gives about its own: a second
 * sort is a second way for a cursor to be spent against the wrong column, and
 * `server/repo/cursor.ts` measured that one of the two things that happens then
 * is a page silently returning 2 of 8 rows.
 */
const SORT_KEY = 'prospect_last_seen';

function rowToProspect(row: Record<string, unknown>): Prospect {
  return {
    email: String(row.email),
    displayName: row.display_name == null ? null : String(row.display_name),
    hasBasket: row.has_basket === true,
    hasAccount: row.has_account === true,
    isSubscriber: row.is_subscriber === true,
    subscribeState: row.subscribe_state as SubscribeState,
    /* `::int` in the statement, so this is a JS number in both drivers, and
       `::bigint` on the money, so it is a string under Neon and under the
       Neon-like PGlite the suites run. `Number()` closes both, and the money
       stays an integer count of minor units the whole way through. */
    basketItems: Number(row.basket_items),
    basketMinor: Number(row.basket_minor),
    currency: String(row.currency),
    lastSeenAt: toEpochMs(row.last_seen_at),
    lastNudgeAt: toEpochMsOrNull(row.last_nudge_at),
  };
}

/**
 * One page of people who have not bought, most recently seen first.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOBODY WHO HAS EVER ORDERED APPEARS ON ANY TAB. The screen is called "Not
 * bought yet" and that is the whole premise: a buyer on it is a person who
 * would be nudged about a basket they have already paid for, which is the
 * single most likely embarrassment in this feature. The exclusion is one
 * `NOT EXISTS` against `shop_orders` on the folded address, applied before the
 * tab predicate rather than inside it, so a tab added later inherits it.
 *
 * THE TABS ARE DISJOINT AND `all` IS THEIR UNION. `basket` is everyone with
 * one; `account` is an account holder WITHOUT a basket; `subscriber` is a
 * subscriber who is neither. So a person who is all three things is one row on
 * `all` carrying three chips, and appears exactly once elsewhere — on the tab
 * that describes the strongest thing known about them. Overlapping tabs would
 * make the same human three rows on three screens and make "how many leads do
 * we have" unanswerable by adding the tabs up.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `lower(email)` IS THE IDENTITY EVERYWHERE — the union key, every join
 * predicate, the sort tiebreak and the cursor's id — because `Ada@Example.test`
 * and `ada@example.test` are one person. It is the same fold
 * `server/shop/admin/customers.ts` applies to buyers, and for the same reason.
 */
export async function listProspects(db: Db, q: ProspectQuery): Promise<ProspectPage> {
  const size = pageLimit(q.limit);
  const tab = q.tab;
  if (tab !== 'basket' && tab !== 'account' && tab !== 'subscriber' && tab !== 'all') {
    throw new BadRequestError('tab');
  }

  /*
   * ONE LIST OF PREDICATES, JOINED WITH `AND`, exactly as `listBuyers` builds
   * its `HAVING`. Each is parenthesised where it pushes, so a clause that grows
   * an `OR` later cannot silently rebind against its neighbours.
   */
  const where: SQL[] = [];

  if (tab === 'basket') where.push(sql`f.has_basket`);
  else if (tab === 'account') where.push(sql`(f.has_account AND NOT f.has_basket)`);
  else if (tab === 'subscriber') {
    where.push(sql`(f.is_subscriber AND NOT f.has_basket AND NOT f.has_account)`);
  }

  /*
   * SUBSTRING, NOT `LIKE`. A caller's text goes in as a bound parameter to
   * `strpos`, where `%` and `_` are ordinary characters — with LIKE they would
   * be wildcards, so searching for a literal underscore would quietly match
   * everything, and escaping them correctly is a thing to get wrong every time
   * a new column joins the search. Folded on both sides so the match is
   * case-insensitive without a functional index being bypassed on the address,
   * which is already stored folded here.
   */
  if (q.query !== undefined) {
    const needle = rejectNul(q.query.trim().toLowerCase(), 'query');
    if (needle !== '') {
      where.push(sql`(strpos(f.email, ${needle}) > 0
                      OR strpos(lower(COALESCE(f.display_name, '')), ${needle}) > 0)`);
    }
  }

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const lastSeenAt = Number(cursor.sortValues[0]);
    if (!Number.isFinite(lastSeenAt)) throw new BadRequestError('cursor');
    /*
     * The id half of the cursor is an EMAIL ADDRESS rather than a row id,
     * because a prospect has no row of their own — that is the point of this
     * file. It goes through `rejectNul` before it is bound: the payload is
     * base64 JSON a caller can hand-write, and a U+0000 in a text comparison is
     * SQLSTATE 22021, a 500 for input that can never be accepted.
     */
    const email = rejectNul(cursor.id, 'cursor');
    where.push(sql`(f.last_seen_at < ${lastSeenAt}
                    OR (f.last_seen_at = ${lastSeenAt} AND f.email > ${email}))`);
  }

  const res = await db.execute(sql`
    WITH cart_addr AS (
      SELECT c.id, c.currency, c.updated_at, ${CART_ADDRESS} AS email
        FROM shop_carts c
        LEFT JOIN shop_customers cu ON cu.id = c.customer_id
       WHERE ${LIVE_CART} AND ${HAS_LINES}
    ),
    /*
     * THE SAME CART basketFor WOULD PICK, chosen by the same rule -- most
     * recently updated, id as the tiebreak -- so the number on the row and the
     * lines in the modal are about one cart. DISTINCT ON rather than a window
     * function because it is one scan and Postgres reads it as the phrase it is.
     */
    picked AS (
      SELECT DISTINCT ON (email) email, id, currency, updated_at
        FROM cart_addr
       WHERE email IS NOT NULL AND email <> ''
       ORDER BY email, updated_at DESC, id ASC
    ),
    baskets AS (
      SELECT p.email, p.currency, p.updated_at,
             COALESCE(sum(l.qty), 0)::int                     AS items,
             /* qty cast first: int * int overflows at about 21 million naira,
                and sum() would only widen the result AFTER the multiply. */
             COALESCE(sum(l.qty::bigint * pz.amount), 0)::bigint AS minor
        FROM picked p
        JOIN shop_cart_lines l ON l.cart_id = p.id
        LEFT JOIN shop_prices pz ON pz.variant_id = l.variant_id
                                AND pz.effective_to IS NULL
       GROUP BY p.email, p.currency, p.updated_at
    ),
    /*
     * GROUPED, because shop_customers_email_uq is unique over the RAW address:
     * two accounts differing only in case -- or in padding -- are storable and
     * are one person here. max() over a group that the fold may have made
     * larger than one is how listBuyers says the same thing.
     */
    accounts AS (
      SELECT ${ACCOUNT_ADDRESS}     AS email,
             max(cu.display_name)   AS display_name,
             min(cu.created_at)     AS created_at
        FROM shop_customers cu
       WHERE cu.email IS NOT NULL AND ${ACCOUNT_ADDRESS} <> ''
       GROUP BY ${ACCOUNT_ADDRESS}
    ),
    /*
     * GROUPED, AND SINCE THE FOLD TRIMS IT HAS TO BE. This CTE used to lean on
     * email_subscribers_email_ck for one row per address, but that check only
     * asks that the address equal its own lower() -- which '  ada@x  ' does --
     * so a padded row and a bare one are two rows the unique index is happy
     * with and the fold makes one. Ungrouped, that would put the same person on
     * the screen twice. unsubscribed_at is max()'d with the rest, so an opt-out
     * on EITHER row suppresses: the safe direction, and the one addSubscriber's
     * "an existing address is never resurrected" rule already takes.
     */
    subs AS (
      SELECT ${SUB_ADDRESS}         AS email,
             max(s.name)            AS name,
             min(s.created_at)      AS created_at,
             max(s.consent_at)      AS consent_at,
             max(s.unsubscribed_at) AS unsubscribed_at
        FROM email_subscribers s
       WHERE ${SUB_ADDRESS} <> ''
       GROUP BY ${SUB_ADDRESS}
    ),
    /*
     * WHEN A BROADCAST LAST REACHED THEM, read off the send and not off
     * email_broadcast_audience. The audience table records who a picked
     * broadcast was AIMED at, which excludes everybody an all_subscribers
     * newsletter reached -- so an operator would see a dash beside somebody
     * mailed last week.
     *
     * A CTE KEYED ON THE FOLDED ADDRESS, NOT A CORRELATED SUBQUERY PER ROW.
     * The subquery this replaces re-joined email_subscribers for every address
     * in folded -- every address, not every address on the page, because it
     * sat below the LIMIT -- and email_broadcast_recipients' only index that
     * mentions subscriber_id is (broadcast_id, subscriber_id), which cannot
     * serve a subscriber_id lookup as its leading column. One grouped pass also
     * survives the fold above: two subscriber rows for one person contribute
     * their sends to the same address rather than to whichever id won a max().
     */
    nudges AS (
      SELECT ${SUB_ADDRESS} AS email, max(r.sent_at) AS last_nudge_at
        FROM email_broadcast_recipients r
        JOIN email_subscribers s ON s.id = r.subscriber_id
       WHERE r.status = 'sent'
       GROUP BY ${SUB_ADDRESS}
    ),
    addresses AS (
      SELECT email FROM baskets
      UNION
      SELECT email FROM accounts
      UNION
      SELECT email FROM subs
    ),
    folded AS (
      SELECT a.email,
             COALESCE(ac.display_name, s.name)  AS display_name,
             (b.email  IS NOT NULL)             AS has_basket,
             (ac.email IS NOT NULL)             AS has_account,
             (s.email  IS NOT NULL)             AS is_subscriber,
             CASE WHEN s.unsubscribed_at IS NOT NULL THEN 'unsubscribed'
                  WHEN s.consent_at      IS NOT NULL THEN 'subscribed'
                  ELSE 'never_asked' END        AS subscribe_state,
             COALESCE(b.items, 0)::int          AS basket_items,
             COALESCE(b.minor, 0)::bigint       AS basket_minor,
             COALESCE(b.currency, '')           AS currency,
             /* Cart last touched, else account created, else subscribed. At
                least one is non-null: the address came from one of the three. */
             COALESCE(b.updated_at, ac.created_at, s.created_at) AS last_seen_at,
             n.last_nudge_at                    AS last_nudge_at
        FROM addresses a
        LEFT JOIN baskets  b  ON b.email  = a.email
        LEFT JOIN accounts ac ON ac.email = a.email
        LEFT JOIN subs     s  ON s.email  = a.email
        LEFT JOIN nudges   n  ON n.email  = a.email
       /*
        * THE ORDER ADDRESS IS FOLDED THE SAME WAY, which costs the functional
        * index shop_orders_email_idx (over lower(email) alone) and buys the
        * thing this predicate is for: a padded address on an order would
        * otherwise fail to match its owner, and the owner would be listed and
        * nudged about a basket they have already paid for. This exclusion only
        * ever removes people, so trimming it errs in the safe direction.
        */
       WHERE NOT EXISTS (SELECT 1 FROM shop_orders o WHERE ${ORDER_ADDRESS} = a.email)
    )
    SELECT f.email, f.display_name, f.has_basket, f.has_account, f.is_subscriber,
           f.subscribe_state, f.basket_items, f.basket_minor, f.currency,
           f.last_seen_at, f.last_nudge_at
      FROM folded f
     ${where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
     ORDER BY f.last_seen_at DESC, f.email ASC
     LIMIT ${size + 1}`);

  const items = res.rows.slice(0, size).map(rowToProspect);
  const last = items[items.length - 1];
  const more = res.rows.length > size;

  return {
    items,
    nextCursor: more && last ? encodeCursor(SORT_KEY, [last.lastSeenAt], last.email) : null,
    unreachableBaskets: await countUnreachableBaskets(db),
  };
}

/**
 * Carts with lines that resolve to no address at all.
 *
 * A SECOND STATEMENT AND NOT A SCALAR SUBQUERY ON THE PAGE, because the page
 * this number matters most on is the EMPTY one — six listed and thirteen
 * unreachable was production's actual shape, and a column on a row set with no
 * rows in it answers nothing. Two reads rather than one is the price of the
 * number surviving an empty page, and both are reads, so there is no
 * consistency question worth a transaction (which the Neon HTTP driver refuses
 * outright in any case).
 *
 * COUNTED PER CART, NOT PER PERSON: a cart with no address cannot be folded
 * onto anybody, so each one is its own anonymous basket. Scoped to the same
 * live-with-lines predicate the list uses, so the two numbers describe one
 * population split in two rather than two overlapping ones.
 */
async function countUnreachableBaskets(db: Db): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM shop_carts c
      LEFT JOIN shop_customers cu ON cu.id = c.customer_id
     WHERE ${LIVE_CART}
       AND ${HAS_LINES}
       AND (${CART_ADDRESS} IS NULL OR ${CART_ADDRESS} = '')`);
  return Number(res.rows[0]?.n ?? 0);
}
