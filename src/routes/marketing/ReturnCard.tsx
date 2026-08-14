import { fmtPoints, fmtUnits, labelsOf, type ReturnListItem } from '../../data/api-marketing';
import { ageModifier, ago } from './queue-shared';

/**
 * One return, as a card — frame F of the wireframe, annotated six ways.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR LINES, NONE NEEDING A SECOND GLANCE TO DECODE. Every one of them earns
 * its place, and the reasoning for each is worth keeping because each looks
 * droppable in isolation:
 *
 * 1. THE LABEL BAR is the waiting band — red past 96h, amber past 48h, nothing
 *    when nothing is wrong. It replaces the coloured dots that used to sit
 *    beside a column's name, and the replacement is the point: every card in a
 *    column has a DIFFERENT age, so urgency belongs to the card and never to the
 *    list. It is what makes a late card findable from the far side of a board.
 * 2. WHO. Their name when there is one, their checkout email when there is not.
 *    Returns are keyed on email, so an address is never wrong — only less
 *    friendly.
 * 3. THE LOAD, in the programme's own words. "6 canisters" is rendered from the
 *    programme's unit labels; rename it and every card says the new word. The
 *    number decides van capacity, so it is the boldest thing after the name.
 * 4. THE WAIT, again, IN WORDS. Colour is never the only carrier: "4d 6h" says
 *    it for anyone who cannot separate the red bar from the amber one.
 * 5. WHAT IT IS WORTH. Quantity × the rate promised WHEN IT WAS REQUESTED — the
 *    snapshot, never the programme's current rate — so a twelve-unit return is
 *    visibly worth ten times a small one before you decide whose van to fill.
 * 6. THE MONOGRAM. Where Trello puts a member's avatar this puts the CUSTOMER's
 *    initials: this application has no member photos, and two letters are enough
 *    to tell two rows apart while scanning.
 *
 * ONE COMPONENT FOR DESKTOP AND PHONE. The card is the same object in both; only
 * the container it sits in changes. Two renderers would drift, and the thing
 * they would drift on is the age band — which is the one part a person is
 * relying on to be identical everywhere.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Two letters for a person, from whatever we actually know about them.
 *
 * A NAME'S INITIALS WHEN THERE IS A NAME, and the address otherwise — which is
 * the common case, because guest checkout is the default path and an email is
 * all a guest leaves behind.
 *
 * THE LOCAL PART BEFORE THE `@`, NEVER THE DOMAIN. Everybody at one company
 * shares a domain, so monograms drawn from it would be identical for exactly the
 * customers a monogram exists to tell apart. The domain is the last resort, for
 * the absurd-but-legal address whose local part has no letters at all.
 *
 * Non-letters are dropped rather than rendered: an address beginning `_dara` or
 * `21-dara` would otherwise put punctuation and digits where a person goes.
 */
export function monogram(name: string | null, email: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2).toUpperCase();

  const onlyLetters = (value: string) => value.replace(/[^a-zA-Z]/g, '');
  const local = onlyLetters(email.split('@')[0] ?? '');
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();

  /* One letter beats an empty disc, and an empty disc beats a crash. Falling
   * through to the whole address covers the address that is all digits before
   * the `@`; `?` covers the one that is not an address at all, which the column
   * CHECK forbids but a fixture can still produce. */
  const anywhere = local || onlyLetters(email);
  return (anywhere || '?').slice(0, 2).toUpperCase();
}

/**
 * What this return would be worth if every declared unit were accepted.
 *
 * A CEILING AND NOT A PROMISE, which is why the card writes it with an arrow.
 * Nothing has been counted yet — the customer said six and the driver may come
 * back with five — so this is the number that decides which van to fill rather
 * than the number anybody will be paid. Once a return is awarded the card shows
 * what was ACTUALLY awarded instead, because by then the guess is history.
 */
export function worthOf(row: ReturnListItem): number {
  return row.pointsAwarded ?? row.qtyDeclared * row.pointsPerUnitSnapshot;
}

export function ReturnCard({
  row,
  now,
  selected,
  onOpen,
  onToggle,
  dragging = false,
}: {
  row: ReturnListItem;
  now: number;
  /** Multi-select state. `undefined` means the board is not in selection mode
   *  and the card renders no checkbox at all. */
  selected?: boolean;
  onOpen: (row: ReturnListItem) => void;
  onToggle?: (row: ReturnListItem) => void;
  /** True while this card is the one under the pointer, so the placeholder it
   *  left behind and the card in hand can be drawn differently. */
  dragging?: boolean;
}) {
  const labels = labelsOf(row.program);
  const waited = Math.max(0, now - row.createdAt);
  const band = ageModifier(waited);
  const worth = worthOf(row);

  return (
    <article
      className={`mktcard${band.replace('mktage', 'mktcard')}${dragging ? ' mktcard--lifted' : ''}${
        selected === true ? ' mktcard--picked' : ''
      }`}
      /*
       * A BUTTON WOULD BE WRONG HERE and a div with a click handler would be
       * worse. The card has a control inside it (the checkbox), so nesting it in
       * a button is invalid; `role="button"` plus a key handler is what gives a
       * keyboard the same reach a pointer has, which is the property that makes
       * this board a peer of the list it replaces rather than a regression.
       */
      role="button"
      tabIndex={0}
      aria-label={`${row.customerName ?? row.customerEmail}, ${fmtUnits(row.qtyDeclared, labels)}`}
      onClick={() => onOpen(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(row);
        }
      }}
    >
      {/* 1. The label bar. Empty when nothing is wrong — an always-present bar
             would be decoration, and this one is a claim. */}
      {band !== '' && <span className="mktcard__band" aria-hidden="true" />}

      {onToggle !== undefined && (
        <label className="mktcard__pick" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected === true}
            onChange={() => onToggle(row)}
            aria-label={`Select ${row.customerName ?? row.customerEmail}`}
          />
        </label>
      )}

      <div className="mktcard__body">
        {/* 2. Who. */}
        <p className="mktcard__who">{row.customerName ?? row.customerEmail}</p>

        <p className="mktcard__facts">
          {/* 3. The load, in the programme's own words. */}
          <b className="mktcard__load">{fmtUnits(row.qtyDeclared, labels)}</b>
          {/* 4. The wait, in words as well as in colour. */}
          <span className={`mktage${band}`}>{ago(waited)}</span>
        </p>

        {/* 5. What it is worth. An arrow while it is still a ceiling; a plain
               figure once the counting has happened and it is a fact. */}
        <p className="mktcard__worth">
          {row.pointsAwarded === null ? '→ ' : ''}
          {fmtPoints(worth, labels)}
        </p>
      </div>

      {/* 6. The monogram. */}
      <span className="mktcard__mono" aria-hidden="true">
        {monogram(row.customerName, row.customerEmail)}
      </span>
    </article>
  );
}
