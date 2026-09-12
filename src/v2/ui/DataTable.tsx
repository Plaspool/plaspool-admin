import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpDown,
  ArrowUpRight,
  Columns3,
  Eye,
  EyeOff,
  GripVertical,
  Maximize2,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import { Toggle } from './Field';
import { Button } from './primitives';
import { Modal } from './Modal';
import { TableScroll } from './TableScroll';
import { Float } from './Float';

/**
 * THE table. Singular, deliberately — see the header of `page.css`.
 *
 * SECOND-PASS API: the table now owns its whole head — tabs, search, and the
 * VIEW CONTROL (sort + per-column visibility) at the top right, the way the
 * reference draws it. Centralising the head is what made the view control
 * possible at all: column visibility is the table's own state, so the button
 * that edits it has to live where that state lives.
 *
 * LOADING IS A SKELETON, NOT A SPINNER. The columns are known before the rows
 * arrive, so the wait shows the exact shape the data will land in — header,
 * row rhythm, thumbnail wells — and the page does not reflow on arrival. A
 * spinner is for shapes you cannot predict; a table is never that.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** The view control needs a plain-text name; `header` may be a node. */
  label?: string;
  numeric?: boolean;
  tight?: boolean;
  /** The identity column: thumbnail treatment, may wrap, and is the one
   *  column the view control refuses to hide. */
  primary?: boolean;
  /**
   * Where this column lives on a PHONE (the owner's second mobile round):
   * `'keep'` stays on the collapsed card as a label-left / value-right row —
   * for the one or two facts that govern a scan, and for inline editors that
   * must stay a tap away. `'sheet'` (the default) moves to the per-row
   * details sheet behind the card's expand key, because a card carrying
   * every column is a table wearing a card's clothes. When a screen marks
   * nothing, the FIRST non-primary column is kept, so an untouched screen
   * still shows one fact rather than a bare title.
   */
  mobile?: 'keep' | 'sheet';
  /** Sticks the column to the scroll's right edge on DESKTOP, so a wide
   *  table's clip can never swallow it — for the per-row ⋯ and lone action
   *  keys, which a row cannot work without. Phones lay these out themselves. */
  pin?: boolean;
  render: (row: T) => ReactNode;
}

export interface TabsConfig<V extends string> {
  value: V;
  tabs: { value: V; label: string }[];
  onChange: (next: V) => void;
}

export interface SearchConfig {
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}

/**
 * ONE named filter beside the search box — a second dimension the tabs cannot
 * carry, because the tabs already spend themselves on status. Deliberately a
 * plain labelled select rather than a second tab strip: two rows of tabs read
 * as one broken row, and the label is what says WHICH dimension this is.
 */
export interface FilterConfig {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}

export interface SortConfig {
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}

/**
 * Bulk selection, the reference's shape: a checkbox column, and — while
 * anything is ticked — a selection bar that TAKES THE HEADER ROW'S SLOT
 * (you cannot sort and bulk-act in the same moment, so the two never need to
 * coexist). Pills for the common actions, a grouped ⋯ menu for the rest, and
 * a "Show all selected" switch that filters the page to the ticked rows.
 */
export interface BulkAction {
  label: string;
  icon?: ReactNode;
  critical?: boolean;
  onAction: (keys: string[]) => void;
}

export interface BulkConfig {
  /** The one or two most common actions, promoted to pills on the bar. */
  pills: BulkAction[];
  /** The rest, grouped. A group may carry a small section heading. */
  menuGroups?: { section?: string; items: BulkAction[] }[];
}

function storageKey(caption: string): string {
  return `plaspool.v2.cols.${caption}`;
}

export function DataTable<T, V extends string = string>({
  columns,
  rows,
  rowKey,
  hrefFor,
  onRowClick,
  empty,
  footer,
  caption,
  tabs,
  search,
  filter,
  sort,
  bulk,
  initialSelected,
  loading = false,
  skeletonRows = 6,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  hrefFor?: (row: T) => string;
  /** For a row whose "open" is a panel rather than a route — the review
   *  modal. Ignored when `hrefFor` is set: a real href wins, because it
   *  keeps middle-click and open-in-new-tab. */
  onRowClick?: (row: T) => void;
  /** Rendered when there are no rows AND nothing is loading. */
  empty: ReactNode;
  footer?: ReactNode;
  caption: string;
  tabs?: TabsConfig<V>;
  search?: SearchConfig;
  filter?: FilterConfig;
  sort?: SortConfig;
  bulk?: BulkConfig;
  /** Pre-ticked keys — exists for the design-gallery specimen. */
  initialSelected?: string[];
  loading?: boolean;
  skeletonRows?: number;
}) {
  const navigate = useNavigate();

  /* Column visibility, remembered per table for the browser session — same
     store and same reasoning as the analytics bar: a fresh visit starts with
     every column, a working session keeps your arrangement. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey(caption));
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggleColumn(key: string) {
    setHidden((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.sessionStorage.setItem(storageKey(caption), JSON.stringify([...next]));
      } catch {
        /* forgetting the arrangement is survivable */
      }
      return next;
    });
  }

  /* ── bulk selection ──────────────────────────────────────────────────── */
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSelected ?? []),
  );
  const [onlySelected, setOnlySelected] = useState(false);
  const allKeys = useMemo(() => rows.map(rowKey), [rows, rowKey]);

  /* Rows change under the selection (tab switch, page turn): prune ticks for
     rows that no longer exist, so the count never claims ghosts. */
  useEffect(() => {
    setSelected((was) => {
      const live = new Set([...was].filter((k) => allKeys.includes(k)));
      return live.size === was.size ? was : live;
    });
  }, [allKeys]);

  useEffect(() => {
    if (selected.size === 0) setOnlySelected(false);
  }, [selected.size]);

  function toggleRow(key: string) {
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allTicked = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someTicked = selected.size > 0;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    /* `indeterminate` is a DOM property, not an attribute. */
    if (headRef.current) headRef.current.indeterminate = someTicked && !allTicked;
  }, [someTicked, allTicked]);

  const shownRows = bulk && onlySelected ? rows.filter((r) => selected.has(rowKey(r))) : rows;

  const visible = columns.filter((c) => c.primary || !hidden.has(c.key));
  const hideable = columns.filter((c) => !c.primary);

  /* The card layout's label (page.css, ≤48rem): each non-primary cell carries
     its column's name so a row can become a stack of labelled facts. The same
     string the view control shows, so the card and the column picker never
     disagree; an empty one marks an unnamed action column, which the card
     floats to its corner instead of labelling. The primary cell carries none —
     the identity labels itself. */
  const cardLabel = (c: Column<T>): string | undefined =>
    c.primary ? undefined : (c.label ?? (typeof c.header === 'string' ? c.header : ''));

  /* Which columns survive on the collapsed card. Explicit marks win; with
     none, the first non-primary visible column is kept — one governing fact,
     never zero. Unnamed action columns are corner-floated by CSS and are
     neither kept nor sheeted. */
  const explicitKeeps = visible.some((c) => c.mobile === 'keep');
  const firstFact = visible.find((c) => !c.primary && cardLabel(c) !== '');
  const cardMobile = (c: Column<T>): 'keep' | 'sheet' | undefined => {
    if (c.primary || cardLabel(c) === '') return undefined;
    if (c.mobile) return c.mobile;
    return !explicitKeeps && c === firstFact ? 'keep' : 'sheet';
  };

  /* The per-row details sheet (mobile only — its expand key exists only in
     the card layout). Values are LIVE renders, so an inline editor works the
     same in the sheet as it does in a desktop cell. */
  const [sheetRow, setSheetRow] = useState<T | null>(null);
  useEffect(() => {
    /* Rows changed under the sheet (a save re-read the list): re-point at the
       same row by key, or close if it is gone. */
    setSheetRow((was) => {
      if (was === null) return was;
      return rows.find((r) => rowKey(r) === rowKey(was)) ?? null;
    });
  }, [rows, rowKey]);
  const hasViewMenu = Boolean(sort) || hideable.length > 0;
  const hasHead = Boolean(tabs) || Boolean(search) || hasViewMenu;

  return (
    <div className="tcard">
      {tabs ? (
        <div className="ttabs" role="tablist">
          {tabs.tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              className="ttab"
              aria-selected={tabs.value === t.value}
              onClick={() => tabs.onChange(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}

      {hasHead && (search || filter || hasViewMenu) ? (
        <div className="tfilter">
          {search ? (
            <div className="tfilter__search">
              <Search aria-hidden="true" />
              <input
                className="input"
                type="search"
                value={search.value}
                placeholder={search.placeholder}
                aria-label={search.placeholder}
                onChange={(e) => search.onChange(e.target.value)}
              />
            </div>
          ) : (
            <span className="spacer" />
          )}
          {filter ? (
            <select
              className="select"
              value={filter.value}
              aria-label={filter.label}
              onChange={(e) => filter.onChange(e.target.value)}
              style={{ flex: 'none', maxWidth: '12rem' }}
            >
              {filter.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : null}
          {hasViewMenu ? (
            <ViewControl
              sort={sort}
              columns={hideable.map((c) => ({ key: c.key, name: c.label ?? String(c.header) }))}
              hidden={hidden}
              onToggle={toggleColumn}
            />
          ) : null}
        </div>
      ) : null}

      {bulk && someTicked && !loading ? (
        <div className="tsel">
          <label className="check" style={{ margin: 0 }}>
            <input
              ref={headRef}
              type="checkbox"
              checked={allTicked}
              aria-label={allTicked ? 'Clear selection' : 'Select every row on this page'}
              onChange={() => setSelected(allTicked ? new Set() : new Set(allKeys))}
            />
          </label>
          <span className="tsel__count">{selected.size} selected</span>
          {bulk.pills.map((a) => (
            <Button key={a.label} onClick={() => a.onAction([...selected])}>
              {a.icon}
              {a.label}
            </Button>
          ))}
          {bulk.menuGroups?.length ? (
            <BulkMenu groups={bulk.menuGroups} keysSelected={[...selected]} />
          ) : null}
          <span className="tsel__spacer" />
          <Toggle label="Show all selected" checked={onlySelected} onChange={setOnlySelected} />
        </div>
      ) : null}

      {loading ? (
        <SkeletonTable columns={visible} rows={skeletonRows} caption={caption} />
      ) : rows.length === 0 ? (
        empty
      ) : (
        <>
          <TableScroll className="tscroll">
            <table className="table">
              <caption className="sr">{caption}</caption>
              {/* The selection bar occupies the header's slot: while rows are
                  ticked the column headers stand down. */}
              {bulk && someTicked ? null : (
                <thead>
                  <tr>
                    {bulk ? (
                      <th scope="col" className="th--tight">
                        <label className="check" style={{ margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={false}
                            aria-label="Select every row on this page"
                            onChange={() => setSelected(new Set(allKeys))}
                          />
                        </label>
                      </th>
                    ) : null}
                    {visible.map((c) => (
                      <th
                        key={c.key}
                        scope="col"
                        className={[
                          c.numeric ? 'th--num' : '',
                          c.tight ? 'th--tight' : '',
                          c.pin ? 'th--pin' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {shownRows.map((row) => {
                  const href = hrefFor?.(row);
                  const open = href
                    ? () => navigate(href)
                    : onRowClick
                      ? () => onRowClick(row)
                      : null;
                  return (
                    <tr
                      key={rowKey(row)}
                      className={open ? 'is-clickable' : undefined}
                      onClick={
                        open
                          ? (event) => {
                              /* A click on a real control inside the row is
                                 that control's click, not the row's. */
                              const target = event.target as HTMLElement;
                              if (target.closest('a,button,input,label,select')) return;
                              open();
                            }
                          : undefined
                      }
                    >
                      {bulk ? (
                        <td className="cell--tight">
                          <label className="check" style={{ margin: 0 }}>
                            <input
                              type="checkbox"
                              checked={selected.has(rowKey(row))}
                              aria-label="Select row"
                              onChange={() => toggleRow(rowKey(row))}
                            />
                          </label>
                        </td>
                      ) : null}
                      {visible.map((c) => (
                        <td
                          key={c.key}
                          data-label={cardLabel(c)}
                          data-mobile={cardMobile(c)}
                          className={[
                            c.numeric ? 'cell--num' : '',
                            c.tight ? 'cell--tight' : '',
                            c.primary ? 'cell--primary' : '',
                            c.pin ? 'cell--pin' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {c.render(row)}
                        </td>
                      ))}
                      {/* The card's expand key — a real cell so the row stays
                          valid HTML; display:none above the breakpoint, so
                          desktop's table never sees an extra column. */}
                      <td className="cell--expand">
                        <button
                          type="button"
                          className="trowx"
                          aria-label="Show all details"
                          aria-haspopup="dialog"
                          onClick={() => setSheetRow(row)}
                        >
                          <Maximize2 aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
          {footer}
        </>
      )}

      {sheetRow !== null ? (
        <Modal title="Details" onClose={() => setSheetRow(null)}>
          <div className="stack stack--tight">
            {/* The identity leads, exactly as it does on the card. */}
            <div className="rsheet__id">
              {visible.find((c) => c.primary)?.render(sheetRow)}
            </div>
            {/* Every column, one fact per row — the defs grammar, so the
                sheet reads like the payment card rather than like a second
                table. Renders are live: a toggle or an inline editor works
                here exactly as it does in a desktop cell. */}
            <div className="defs rsheet__defs">
              {visible
                .filter((c) => !c.primary)
                .map((c) => (
                  <div className="defs__row" key={c.key}>
                    <span className="defs__label">{cardLabel(c) || 'Actions'}</span>
                    <span className="defs__value">{c.render(sheetRow)}</span>
                  </div>
                ))}
            </div>
            {(hrefFor || onRowClick) && (
              <Button
                tone="default"
                onClick={() => {
                  const row = sheetRow;
                  setSheetRow(null);
                  const href = hrefFor?.(row);
                  if (href) navigate(href);
                  else onRowClick?.(row);
                }}
              >
                <ArrowUpRight aria-hidden="true" />
                Open
              </Button>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ BULK ⋯ MENU ════ */

function BulkMenu({
  groups,
  keysSelected,
}: {
  groups: { section?: string; items: BulkAction[] }[];
  keysSelected: string[];
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className="menu">
      <button
        ref={trigger}
        type="button"
        className={'btn btn--default btn--icon' + (open ? ' is-open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More bulk actions"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      <Float
        open={open}
        anchor={trigger}
        align="left"
        className="menu__panel menu__panel--groups"
        role="menu"
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
        {groups.map((group, gi) => (
          <div key={gi}>
            {gi > 0 ? <div className="menu__sep" role="separator" /> : null}
            {group.section ? <div className="menu__section">{group.section}</div> : null}
            {group.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.critical ? 'menu__item menu__item--critical' : 'menu__item'}
                onClick={() => {
                  setOpen(false);
                  item.onAction(keysSelected);
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </Float>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ SKELETON ════ */

function SkeletonTable<T>({
  columns,
  rows,
  caption,
}: {
  columns: Column<T>[];
  rows: number;
  caption: string;
}) {
  /* Deterministic "pseudo-random" widths in REM, cell-stable so re-renders do
     not make the skeleton crawl. Fixed lengths and never percentages: a % here
     resolves against an auto-width table cell, whose width comes from its
     content, which is the bar itself — a circle that resolved to 0px and drew
     nothing. Measured, in the first cut. */
  const bar = (r: number, c: number, base: number, spread: number) =>
    `${(base + ((r * 7 + c * 13) % (spread * 4)) / 4).toFixed(2)}rem`;

  return (
    <div className="tscroll" aria-hidden="true">
      <table className="table">
        <caption className="sr">Loading {caption}…</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={[c.numeric ? 'th--num' : '', c.tight ? 'th--tight' : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {columns.map((c, i) =>
                c.primary ? (
                  <td key={c.key} className="cell--primary">
                    <span className="idcell">
                      <span className="skel skel--thumb" />
                      <span className="idcell__text" style={{ gap: 6 }}>
                        <span className="skel" style={{ width: bar(r, i, 9, 4) }} />
                        <span className="skel" style={{ width: bar(r, i + 1, 5.5, 3), opacity: 0.6 }} />
                      </span>
                    </span>
                  </td>
                ) : (
                  <td key={c.key} className={c.numeric ? 'cell--num' : undefined}>
                    <span
                      className="skel"
                      style={{ width: c.tight || c.numeric ? '2.5rem' : bar(r, i, 4, 3) }}
                    />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ VIEW CONTROL ════ */

function ViewControl({
  sort,
  columns,
  hidden,
  onToggle,
}: {
  sort?: SortConfig;
  columns: { key: string; name: string }[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className={sort ? 'tview' : 'tview tview--nosort'}>
      <button
        ref={trigger}
        type="button"
        className={'btn btn--plain btn--icon' + (open ? ' is-open' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Arrange columns and sorting"
        title="Arrange columns and sorting"
        onClick={() => setOpen((v) => !v)}
      >
        <Columns3 aria-hidden="true" />
      </button>
      {/* NOT a menu: toggling a column keeps the panel up, because arranging
          a view is several choices in a row, not one action. Only Escape,
          the trigger, or clicking away closes it — which is exactly Float's
          contract: clicks inside the portaled panel are inside `panel` and
          never count as outside. (It used to hang absolute inside the card,
          and `.tcard`'s rounded overflow cut it off mid-list — the owner's
          Broadcasts screenshot.) */}
      <Float
        open={open}
        anchor={trigger}
        align="right"
        className="tview__panel"
        role="dialog"
        ariaLabel="View options"
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
          {sort ? (
            <label className="tview__row" style={{ gap: 'var(--s2)' }}>
              <ArrowUpDown aria-hidden="true" style={{ width: 15, height: 15, color: 'var(--ink-sub)', flex: 'none' }} />
              <span style={{ flex: 'none' }}>Sort by</span>
              <select
                className="select"
                value={sort.value}
                onChange={(e) => sort.onChange(e.target.value)}
                aria-label="Sort by"
              >
                {sort.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {columns.length ? (
            /* Wrapped so the phone layout can drop the column eyes while the
               sort stays — the card decides its own columns there. */
            <div className="tview__cols">
              <div className="tview__label">Columns</div>
              {columns.map((c) => {
                const off = hidden.has(c.key);
                return (
                  <div className={off ? 'tview__row is-off' : 'tview__row'} key={c.key}>
                    <span className="tview__grip" aria-hidden="true">
                      <GripVertical />
                    </span>
                    <span className="tview__name">{c.name}</span>
                    <button
                      type="button"
                      className="tview__eye"
                      aria-pressed={!off}
                      aria-label={off ? `Show ${c.name} column` : `Hide ${c.name} column`}
                      onClick={() => onToggle(c.key)}
                    >
                      {off ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
      </Float>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ THE PIECES ══ */

/** The identity cell: thumbnail, title, and one line of context under it. */
export function IdCell({
  thumb,
  title,
  href,
  meta,
}: {
  thumb?: ReactNode;
  title: ReactNode;
  href?: string;
  meta?: ReactNode;
}) {
  return (
    <div className="idcell">
      {thumb !== undefined ? (
        <span className="idcell__thumb" aria-hidden="true">
          {thumb}
        </span>
      ) : null}
      <span className="idcell__text">
        {href ? (
          <a className="idcell__title" href={`#${href}`}>
            {title}
          </a>
        ) : (
          <span className="idcell__title">{title}</span>
        )}
        {meta ? <span className="idcell__meta">{meta}</span> : null}
      </span>
    </div>
  );
}

/** The pager. Cursor-based like every list endpoint here: no total exists, so
 *  no page number is invented. */
export function TablePager({
  note,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  note?: ReactNode;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (!canPrev && !canNext && !note) return null;
  return (
    <div className="tfoot">
      {note ? <span>{note}</span> : null}
      <div className="tfoot__pager">
        <Button tone="default" iconOnly aria-label="Previous page" disabled={!canPrev} onClick={onPrev}>
          ‹
        </Button>
        <Button tone="default" iconOnly aria-label="Next page" disabled={!canNext} onClick={onNext}>
          ›
        </Button>
      </div>
    </div>
  );
}
