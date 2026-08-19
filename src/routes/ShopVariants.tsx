import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  Banknote,
  Boxes,
  Check,
  History,
  ImagePlus,
  Minus,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  shopApi,
  currencyDigits,
  formatMinor,
  moneyRefusalMessage,
  parseMajor,
  plainMajor,
  type ShopProductDetail,
  type ShopVariant,
} from '../data/api-shop';
import { api } from '../data/api';
import { ApiError } from '../data/errors';
import { ImageError, storeImageFile } from '../data/images';
import { Select } from '../components/ui/Select';
import { useToast } from '../components/Toast';
import './shop.css';

/**
 * Variants, rebuilt around the question a person actually starts from.
 *
 * WHAT IT ASKS. Does this come in variations? If yes, WHICH KINDS — colour,
 * size, whatever this product varies by — and then the VALUES of each. The
 * combinations follow from that, and so do the SKUs (`server/shop/catalog/
 * sku.ts` derives them). One decision per screenful, in the order somebody
 * already knows the answers.
 *
 * LOOKING IS NOT CHANGING. Selecting a variant in the rail shows a READ view —
 * the photo, the code, the price, what is left — and each change is its own
 * deliberate act behind its own button: adjust the price, adjust the stock,
 * change the photo. The first two demand a WHY and record it forever; the photo
 * does not, which is exactly why it is a separate act rather than a field
 * sitting between two audited ones.
 *
 * THE WHY SITS ABOVE ITS DROPDOWN, AS A VISIBLE LABEL. The old layout put a
 * bare dropdown beside the number and explained it in a hint BELOW the button —
 * so the one field whose meaning is not guessable from its shape was the one
 * field with no name. A blank Select reading "Why…" only helps after you open
 * it; "Why did the price change?" above it helps before.
 *
 * COLOURS CARRY A CODE. A colour option is the one kind a swatch settles, so
 * the builder offers preset colours as check-a-box (name and code together) and
 * a custom row that asks for both. The code lands on `variant.colorHex` — a
 * column, never a key inside `optionValues`, because the tuple is the variant's
 * identity and feeds SKU derivation while a swatch is presentation.
 */

// ------------------------------------------------------------------- reasons

/**
 * The reasons stock actually moves, offered rather than typed.
 *
 * A mandatory free-text box gets "adjustment", "fix", "x" — which satisfies the
 * server's `reason` and tells the next reader nothing, so the audit trail is
 * technically complete and practically empty. These are the six answers, and
 * "Something else" is still there for the seventh.
 */
const STOCK_REASONS = [
  'Delivery arrived from the distributor',
  'Stocktake recount',
  'Damaged or faulty — written off',
  'Returned by a customer',
  'Sold outside the shop',
  'Correcting an earlier mistake',
];

/** The same idea for a price. A price that moves for no recorded reason is the
 *  row somebody will be squinting at in six months. */
const PRICE_REASONS = [
  'Distributor raised the price',
  'New supplier invoice',
  'Exchange rate moved',
  'Promotion starts',
  'Promotion ends',
  'Correcting an earlier mistake',
];

const OTHER = '__other__';

/**
 * A reason picker under its own visible question.
 *
 * The label is rendered ABOVE the control — not beside it, not in a hint after
 * the button — so the dropdown is legible before it is opened. The free-text
 * box only appears once "Something else" is chosen, so the common path is one
 * click and the uncommon one is still open.
 */
function ReasonPicker({
  presets,
  value,
  onChange,
  label,
}: {
  presets: string[];
  value: string;
  onChange: (v: string) => void;
  /** The visible question AND the accessible name — "Why did the price
   *  change?" — so eyes and screen readers hear the same thing, and the two
   *  pickers on this panel stay distinguishable to both. */
  label: string;
}) {
  const isPreset = presets.includes(value);
  const [custom, setCustom] = useState(!isPreset && value !== '');
  const selection = custom ? OTHER : isPreset ? value : '';

  return (
    <div className="vreason">
      <span className="label">{label}</span>
      <Select
        label={label}
        size="sm"
        value={selection}
        placeholder="Choose a reason…"
        onChange={(v) => {
          if (v === OTHER) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
        options={[
          // Radix renders the PLACEHOLDER for the '' selection, so this row's
          // label only ever appears inside the open menu — where "Choose a
          // reason…" reads as the instruction it is.
          { value: '', label: 'Choose a reason…' },
          ...presets.map((r) => ({ value: r, label: r })),
          { value: OTHER, label: 'Something else…' },
        ]}
      />
      {custom && (
        <input
          className="input input--sm"
          value={value}
          maxLength={400}
          autoFocus
          placeholder="In your own words"
          aria-label={`${label} — your own words`}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ what varies

/** `Colour`, `colours`, `color` — the one axis kind a swatch settles. */
export const isColourAxis = (name: string): boolean => /^colou?rs?$/i.test(name.trim());

/** One offered value. `hex` only ever comes from a colour axis. */
interface PresetValue {
  value: string;
  hex?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY AXIS KIND GETS VALUES TO CLICK, NOT JUST COLOUR.
 *
 * Presets started as a colour-only affordance and that was half a feature: a
 * shopkeeper setting up sizes still had to type `XS S M L XL` one at a time,
 * inventing the spelling and the order each time, while the person next to
 * them checked eight colours in eight clicks. The typing is where the case
 * mess and the near-miss spellings (`1kg` vs `1 kg` vs `1KG`) come from, so
 * the axis with no presets is the axis that grows twins.
 *
 * The vocabularies below lean at THIS catalogue — it sells filament, so
 * Material offers PETG and Weight offers 750 g — because a preset list that
 * matches the shop is a click and one that does not is noise. Every axis
 * still takes free text, and an axis nobody listed here (`Nozzle`, `Length`)
 * simply gets the text box on its own, exactly as before.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const AXIS_KINDS: { match: RegExp; values: PresetValue[] }[] = [
  {
    // Named colours with their codes, so one click records both. A customer
    // choosing between eight spools is choosing between eight words until
    // something on the page is actually coloured.
    match: /^colou?rs?$/i,
    values: [
      { value: 'Black', hex: '#111111' },
      { value: 'White', hex: '#f5f5f0' },
      { value: 'Grey', hex: '#9ca3af' },
      { value: 'Silver', hex: '#c0c0c8' },
      { value: 'Red', hex: '#c62828' },
      { value: 'Orange', hex: '#ef6c00' },
      { value: 'Yellow', hex: '#f9a825' },
      { value: 'Green', hex: '#2e7d32' },
      { value: 'Blue', hex: '#1565c0' },
      { value: 'Purple', hex: '#6a4fa3' },
      { value: 'Pink', hex: '#d81b60' },
      { value: 'Brown', hex: '#795548' },
      { value: 'Natural', hex: '#e8dcc8' },
      { value: 'Gold', hex: '#c9a227' },
    ],
  },
  {
    match: /^sizes?$/i,
    values: [
      { value: 'XS' },
      { value: 'S' },
      { value: 'M' },
      { value: 'L' },
      { value: 'XL' },
      { value: '2XL' },
      { value: '3XL' },
      { value: 'One size' },
    ],
  },
  {
    /*
     * Spool weights as they are actually sold, and SPELLED ONCE. `1kg`, `1 kg`
     * and `1KG` are three tags in this catalogue's history; the list is what
     * stops a fourth.
     */
    match: /^weights?$/i,
    values: [
      { value: '250 g' },
      { value: '500 g' },
      { value: '750 g' },
      { value: '1 kg' },
      { value: '2 kg' },
      { value: '5 kg' },
    ],
  },
  {
    match: /^materials?$/i,
    values: [
      { value: 'PLA' },
      { value: 'PLA+' },
      { value: 'PETG' },
      { value: 'ABS' },
      { value: 'ASA' },
      { value: 'TPU' },
      { value: 'Nylon' },
      { value: 'Resin' },
      { value: 'Wood-fill' },
      { value: 'Carbon fibre' },
    ],
  },
  {
    match: /^finish(es)?$/i,
    values: [
      { value: 'Matte' },
      { value: 'Glossy' },
      { value: 'Satin' },
      { value: 'Silk' },
      { value: 'Metallic' },
      { value: 'Translucent' },
      { value: 'Transparent' },
      { value: 'Glitter' },
    ],
  },
  {
    match: /^styles?$/i,
    values: [
      { value: 'Solid' },
      { value: 'Dual-tone' },
      { value: 'Gradient' },
      { value: 'Rainbow' },
      { value: 'Marble' },
      { value: 'Glow-in-the-dark' },
      { value: 'Sparkle' },
    ],
  },
  {
    /** The two that exist, plus the legacy one. Nobody should type these. */
    match: /^diameters?$/i,
    values: [{ value: '1.75 mm' }, { value: '2.85 mm' }, { value: '3 mm' }],
  },
];

/** The values offered for an axis, or none for one nobody has a list for. */
function presetsFor(name: string): PresetValue[] {
  return AXIS_KINDS.find((kind) => kind.match.test(name.trim()))?.values ?? [];
}

const fold = (s: string): string => s.trim().toLowerCase();

/** A round swatch, or nothing when there is no code to draw. */
function Swatch({ hex, size = 'sm' }: { hex: string | null; size?: 'sm' | 'md' }) {
  if (!hex) return null;
  return (
    <span
      className={`vswatch vswatch--${size}`}
      style={{ backgroundColor: hex }}
      aria-hidden="true"
    />
  );
}

// ------------------------------------------------------- the option builder

/**
 * The axes people actually use, so the common case is a click — and each of
 * these has a value vocabulary behind it in `AXIS_KINDS`, so choosing one is
 * two clicks from a set of variants rather than a blank box.
 */
const AXIS_PRESETS = ['Colour', 'Size', 'Material', 'Weight', 'Diameter', 'Style', 'Finish'];

interface AxisValue {
  value: string;
  /** Only colour axes carry one. Rides into `variant.colorHex` on create. */
  hex?: string;
}

interface Axis {
  name: string;
  values: AxisValue[];
}

interface CombinationRow {
  options: Record<string, string>;
  /** The hex of this row's colour value, when its axis is a colour. */
  hex?: string;
}

/** Every combination of the axes, in a stable order, each carrying its swatch. */
function combinations(axes: Axis[]): CombinationRow[] {
  const usable = axes.filter((a) => a.name.trim() !== '' && a.values.length > 0);
  if (usable.length === 0) return [];
  return usable.reduce<CombinationRow[]>(
    (acc, axis) =>
      acc.flatMap((row) =>
        axis.values.map((v) => ({
          options: { ...row.options, [axis.name.trim()]: v.value },
          hex: row.hex ?? (isColourAxis(axis.name) ? v.hex : undefined),
        })),
      ),
    [{ options: {} }],
  );
}

/**
 * The tuple's identity up to case and key order — the client's mirror of the
 * server's `foldedTupleKey`, so "this combination already exists" is decided
 * the same way on both sides of the wire.
 */
const foldedTuple = (o: Record<string, string>): string =>
  JSON.stringify(
    Object.entries(o ?? {})
      .map(([k, v]) => [fold(k), fold(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );

/** What this product already calls its values on one axis, by folded name. */
type KnownValues = Map<string, { value: string; hex: string | null }>;

/**
 * An axis's values: what is offered, checkable, plus a row for what is not.
 *
 * ONE COMPONENT FOR EVERY AXIS KIND. It was two — a colour picker and a bare
 * text box — and the split was the bug: only colour got presets, only colour
 * adopted an existing spelling on a case-match, and only colour told you where
 * a swallowed entry went. Sizes and materials got none of it. What is actually
 * colour-specific is exactly one thing, the code beside the name, so that is
 * the only branch left here.
 *
 * A preset is ONE CLICK, and unchecking removes it: the grid is the state of
 * the axis, not a set of buttons that fire and forget.
 */
function ValueChooser({
  axis,
  known,
  onChange,
}: {
  axis: Axis;
  known: KnownValues;
  onChange: (a: Axis) => void;
}) {
  const presets = presetsFor(axis.name);
  const colour = isColourAxis(axis.name);

  const [draft, setDraft] = useState('');
  const [customHex, setCustomHex] = useState('#808080');
  const [notice, setNotice] = useState<string | null>(null);
  // The well beside the hex box never lies: while the typed text is not a
  // colour, it holds the LAST colour it truthfully showed rather than a
  // hardcoded stand-in the user never chose.
  const lastValidHex = useRef('#808080');
  if (/^#[0-9a-f]{6}$/i.test(customHex)) lastValidHex.current = customHex;

  const has = (name: string): boolean => axis.values.some((v) => fold(v.value) === fold(name));

  /** The product's own spelling of this value, when it has one. */
  const adopt = (typed: string): AxisValue => {
    const twin = known.get(fold(typed));
    return {
      value: twin?.value ?? typed,
      ...(twin?.hex ? { hex: twin.hex } : {}),
    };
  };

  function toggle(preset: PresetValue): void {
    setNotice(null);
    if (has(preset.value)) {
      onChange({
        ...axis,
        values: axis.values.filter((v) => fold(v.value) !== fold(preset.value)),
      });
      return;
    }
    // A preset that case-matches a value this product already has ADOPTS the
    // stored spelling — one value, one spelling, however it is reached — and
    // keeps the stored swatch when one was ever set.
    const adopted = adopt(preset.value);
    onChange({
      ...axis,
      values: [...axis.values, { ...adopted, hex: adopted.hex ?? preset.hex }],
    });
  }

  function addTyped(): void {
    const typed = draft.trim();
    setDraft('');
    if (!typed) return;
    const adopted = adopt(typed);
    const respelled = adopted.value !== typed;
    if (has(adopted.value)) {
      // Not silence: the entry went somewhere, and the box should say where.
      setNotice(`“${typed}” is already picked${respelled ? ` — as “${adopted.value}”` : ''}.`);
      return;
    }
    onChange({
      ...axis,
      values: [
        ...axis.values,
        { ...adopted, hex: adopted.hex ?? (colour ? customHex : undefined) },
      ],
    });
    setNotice(respelled ? `Added as “${adopted.value}” — this product’s existing spelling.` : null);
  }

  const label = colour ? 'Custom colour name' : `Add a ${axis.name || 'value'}`;

  return (
    <div className="cpick">
      {presets.length > 0 && (
        <div
          className={`cpick__grid${colour ? '' : ' cpick__grid--flow'}`}
          role="group"
          aria-label={`Common ${axis.name.toLowerCase()} values`}
        >
          {presets.map((preset) => {
            const checked = has(preset.value);
            return (
              <label key={preset.value} className={`cpick__item${checked ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  className="visually-hidden"
                  checked={checked}
                  onChange={() => toggle(preset)}
                />
                {preset.hex ? (
                  <span className="cpick__swatch" style={{ backgroundColor: preset.hex }}>
                    {checked && <Check className="ui-ic" aria-hidden="true" />}
                  </span>
                ) : (
                  checked && <Check className="ui-ic cpick__tick" aria-hidden="true" />
                )}
                {preset.value}
              </label>
            );
          })}
        </div>
      )}

      <div className="cpick__custom">
        <input
          className="input input--sm cpick__name"
          value={draft}
          maxLength={200}
          placeholder={presets.length > 0 ? 'Something else…' : `A ${axis.name || 'value'}…`}
          aria-label={label}
          onChange={(e) => {
            setDraft(e.target.value);
            setNotice(null);
          }}
          onKeyDown={(e) => {
            // Enter adds, and does NOT submit the product form around it.
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTyped();
            }
          }}
          /*
           * Blur adds — but only where there is nowhere else in this row to
           * put the cursor. On a colour axis the next stop is the colour well,
           * and adding on the way to it would file the value before its code
           * was chosen.
           */
          onBlur={colour ? undefined : addTyped}
        />
        {colour && (
          <>
            <input
              type="color"
              className="cpick__well"
              value={lastValidHex.current}
              aria-label="Custom colour code"
              onChange={(e) => setCustomHex(e.target.value)}
            />
            <input
              className="input input--sm cpick__hex"
              value={customHex}
              maxLength={7}
              aria-label="Custom colour code as hex"
              onChange={(e) => {
                const raw = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                setCustomHex(raw.toLowerCase());
              }}
            />
          </>
        )}
        <button
          type="button"
          className="btn btn--outline btn--sm"
          disabled={draft.trim() === '' || (colour && !/^#[0-9a-f]{6}$/i.test(customHex))}
          onClick={addTyped}
        >
          <Plus className="ui-ic" aria-hidden="true" />
          Add
        </button>
      </div>
      {notice && <p className="panel__note">{notice}</p>}
    </div>
  );
}

function AxisEditor({
  axis,
  known,
  onChange,
  onRemove,
}: {
  axis: Axis;
  known: KnownValues;
  onChange: (a: Axis) => void;
  onRemove: () => void;
}) {
  return (
    <div className="vaxis">
      <div className="vaxis__head">
        <input
          className="input input--sm vaxis__name"
          value={axis.name}
          maxLength={100}
          placeholder="Colour"
          aria-label="What varies"
          onChange={(e) => onChange({ ...axis, name: e.target.value })}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onRemove}
          aria-label={`Remove the ${axis.name || 'unnamed'} option`}
        >
          <X className="ui-ic" aria-hidden="true" />
        </button>
      </div>

      {/* What has been chosen so far — chips for both kinds of axis, so a
          checked preset and a typed size read as the same thing. */}
      {axis.values.length > 0 && (
        <div className="vaxis__values">
          {axis.values.map((v) => (
            <span key={v.value} className="chip chip--value">
              <Swatch hex={v.hex ?? null} />
              {v.value}
              <button
                type="button"
                className="chip__x"
                aria-label={`Remove ${v.value}`}
                onClick={() =>
                  onChange({ ...axis, values: axis.values.filter((x) => x.value !== v.value) })
                }
              >
                <X className="ui-ic" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <ValueChooser axis={axis} known={known} onChange={onChange} />
    </div>
  );
}

function OptionBuilder({
  product,
  onDone,
  onCancel,
}: {
  product: ShopProductDetail;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { notify } = useToast();
  const [axes, setAxes] = useState<Axis[]>([{ name: 'Colour', values: [] }]);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => combinations(axes), [axes]);
  const existing = useMemo(
    () => new Set(product.variants.map((v) => foldedTuple(v.optionValues))),
    [product.variants],
  );
  // Combinations this product already has are not offered again — and the
  // comparison folds case, so "black" is not a fresh variant of "Black".
  const fresh = rows.filter((r) => !existing.has(foldedTuple(r.options)));

  /*
   * The product's existing vocabulary, per folded axis name: what each value
   * is already SPELLED like, and the swatch it already carries. Typed and
   * preset entries below adopt these, so a builder round cannot mint a
   * case-twin of something the rail is already showing.
   */
  const knownByAxis = useMemo(() => {
    const map = new Map<string, KnownValues>();
    for (const v of product.variants) {
      for (const [key, value] of Object.entries(v.optionValues ?? {})) {
        const values = map.get(fold(key)) ?? new Map();
        if (!values.has(fold(value))) {
          values.set(fold(value), {
            value,
            hex: isColourAxis(key) ? v.colorHex : null,
          });
        }
        map.set(fold(key), values);
      }
    }
    return map;
  }, [product.variants]);
  const NO_KNOWN: KnownValues = useMemo(() => new Map(), []);

  async function create(): Promise<void> {
    setBusy(true);
    let made = 0;
    try {
      for (const row of fresh) {
        // No SKU: the server derives one per combination. That is the whole
        // reason this screen can ask about colours instead of codes.
        await shopApi.createVariant(product.id, {
          optionValues: row.options,
          ...(row.hex ? { colorHex: row.hex } : {}),
        });
        made += 1;
      }
      notify(made === 1 ? 'One variant added' : `${made} variants added`);
      onDone();
    } catch (err) {
      notify(
        made === 0
          ? explainVariantTrouble(err, 'Nothing was created.')
          : `${made} created, then it stopped. Nothing already made was lost.`,
        { tone: 'danger' },
      );
      if (made > 0) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vbuild">
      <p className="panel__note">
        What does this product vary by? Add the kinds first, then the values of
        each — the combinations and their codes follow from that.
      </p>

      {axes.map((axis, i) => (
        <AxisEditor
          key={i}
          axis={axis}
          known={knownByAxis.get(fold(axis.name)) ?? NO_KNOWN}
          onChange={(next) => setAxes(axes.map((a, j) => (i === j ? next : a)))}
          onRemove={() => setAxes(axes.filter((_, j) => j !== i))}
        />
      ))}

      <div className="vbuild__add">
        {AXIS_PRESETS.filter((p) => !axes.some((a) => fold(a.name) === fold(p))).map((p) => (
          <button
            key={p}
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => setAxes([...axes, { name: p, values: [] }])}
          >
            <Plus className="ui-ic" aria-hidden="true" />
            {p}
          </button>
        ))}
      </div>

      <div className="vbuild__foot">
        <span className="pager__note">
          {rows.length === 0
            ? 'Add at least one value to see what this makes.'
            : fresh.length === 0
              ? // Not "add a value" — a value WAS added; it already lives on
                // this product, and the footer has to say that or the dead
                // Create button reads as a bug.
                'Everything chosen already exists on this product — nothing new to create.'
              : `This makes ${fresh.length} ${fresh.length === 1 ? 'variant' : 'variants'}` +
                (rows.length !== fresh.length
                  ? ` · ${rows.length - fresh.length} already ${rows.length - fresh.length === 1 ? 'exists' : 'exist'}`
                  : '')}
        </span>
        <div className="vbuild__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy || fresh.length === 0}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : `Create ${fresh.length || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}

const sortedOptions = (o: Record<string, string>): [string, string][] =>
  Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b));

/** "Colour Black · Size L", or a plain note when a product has no axes. */
export function optionSummary(v: ShopVariant): string {
  const parts = sortedOptions(v.optionValues).map(([k, val]) => `${k} ${val}`);
  return parts.join(' · ') || 'Single item';
}

/** The variant-route refusals this panel can actually explain. */
function explainVariantTrouble(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === 'duplicate_options') {
      const rec = (err.body ?? {}) as Record<string, unknown>;
      const summary = typeof rec.summary === 'string' ? rec.summary : '';
      return summary
        ? `“${summary}” already exists on this product — the same combination in a different case is still the same combination.`
        : 'That combination already exists on this product.';
    }
    if (err.status === 400 && err.detail === 'colorHex') {
      return 'That colour code isn’t usable — it needs to be a hex code like #8b5a2b.';
    }
    if (err.status === 400 && err.detail === 'optionValues') {
      return 'Those options aren’t usable — every kind and value needs a name, once each.';
    }
    // The check constraint's 400 — reachable despite the client floor, because
    // somebody else can sell or adjust the same variant between read and click.
    if (err.status === 400 && err.detail === 'delta') {
      return 'That change would take the stock below zero — somebody may have moved it first. Reload and look again.';
    }
  }
  return fallback;
}

// ------------------------------------------------------------ the variant card

type CardMode = 'view' | 'price' | 'stock' | 'photo';

/**
 * A number with its two directions on either side of it.
 *
 * WHY NOT A BARE TEXT BOX. Both numbers this panel changes are usually changed
 * by a LITTLE: a delivery of ten, a price up by one. A text box makes the
 * common case "select the old value, retype the whole thing", which is both
 * slower and the way a digit gets dropped — 2650 typed for 26500. The buttons
 * make one step one click and keep the exact arithmetic on our side; the field
 * stays typable for the rare jump.
 *
 * `type="text"` with `inputMode`, not `type="number"`: a number input silently
 * discards what it cannot parse mid-typing, so a half-typed `-` or `.` can
 * vanish under the cursor, and its own spinners cannot be styled to the design
 * system on every browser.
 */
function Stepper({
  id,
  value,
  label,
  placeholder,
  inputMode,
  onType,
  onStep,
  canStepDown = true,
}: {
  id: string;
  value: string;
  /** Names the two buttons — the field has its own visible <label>. */
  label: string;
  placeholder: string;
  inputMode: 'decimal' | 'numeric';
  onType: (v: string) => void;
  onStep: (direction: 1 | -1) => void;
  /** False at a floor, so the control refuses what the form would refuse. */
  canStepDown?: boolean;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Decrease ${label}`}
        disabled={!canStepDown}
        onClick={() => onStep(-1)}
      >
        <Minus className="ui-ic" aria-hidden="true" />
      </button>
      <input
        id={id}
        className="input input--sm stepper__field"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onType(e.target.value)}
      />
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Increase ${label}`}
        onClick={() => onStep(1)}
      >
        <Plus className="ui-ic" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Before → after, with the after emphasised.
 *
 * The old value is the quiet one and the new value is the big one, because the
 * question in front of somebody about to press the button is "what will it be",
 * not "what is it now". `tone` colours the new figure the way the history page
 * already colours the same events — a stock rise is good news, a price rise is
 * the one that generates customer questions — and the WORD is always there
 * beside it, so the colour is emphasis and never the only signal.
 */
function Preview({
  was,
  now,
  tone,
  note,
}: {
  was: string;
  now: string;
  tone: 'good' | 'bad';
  note: string;
}) {
  return (
    <p className="vpreview">
      <span className="vpreview__was">{was}</span>
      <span className="vpreview__arrow" aria-label="becomes">
        →
      </span>
      <strong className={`vpreview__now vpreview__now--${tone}`}>{now}</strong>
      <span className="vpreview__note">{note}</span>
    </p>
  );
}

/**
 * The number, the question, the confirmation — one change per screenful.
 *
 * Shared by the price and stock forms so the two audited changes read
 * identically: what changes, then WHY (labelled, above its dropdown), then the
 * pair of buttons. The photo flow deliberately does not use it — no reason is
 * asked, which is half the point of splitting the modes.
 */
function AdjustForm({
  children,
  reason,
  onReason,
  presets,
  question,
  note,
  confirmLabel,
  confirmDisabled,
  busy,
  onConfirm,
  onCancel,
}: {
  children: React.ReactNode;
  reason: string;
  onReason: (v: string) => void;
  presets: string[];
  question: string;
  /** A whole element, not a string: the callers render a before → after
   *  preview here, and a `<p>` wrapper around one would nest a paragraph. */
  note: React.ReactNode;
  confirmLabel: string;
  confirmDisabled: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="vmode">
      {children}
      <ReasonPicker presets={presets} value={reason} onChange={onReason} label={question} />
      {note}
      <div className="vmode__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy || confirmDisabled}
          onClick={onConfirm}
        >
          {busy ? 'Saving…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}

function VariantCard({
  variant,
  currency,
  onChanged,
}: {
  variant: ShopVariant;
  currency: string;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<CardMode>('view');
  const [busy, setBusy] = useState(false);

  const [priceDraft, setPriceDraft] = useState('');
  const [priceReason, setPriceReason] = useState('');
  const [delta, setDelta] = useState('');
  const [stockReason, setStockReason] = useState('');

  const [colourOpen, setColourOpen] = useState(false);
  const [colourDraft, setColourDraft] = useState(variant.colorHex ?? '#808080');
  // The picker well never shows a colour nobody chose: while the hex text is
  // mid-edit and invalid, it holds the last colour that was truthfully shown.
  const lastValidColour = useRef(variant.colorHex ?? '#808080');
  if (/^#[0-9a-f]{6}$/i.test(colourDraft)) lastValidColour.current = colourDraft;

  const parsed = priceDraft.trim() === '' ? null : parseMajor(priceDraft, currency);
  const priceError = parsed && !parsed.ok ? moneyRefusalMessage(parsed.reason, currency) : null;
  const priceChanged = parsed?.ok === true && parsed.minor !== (variant.price?.amount ?? -1);

  /**
   * One major unit at a time — ₦1, not ₦0.01.
   *
   * Stepped in MINOR units and rendered back through `plainMajor`, so the
   * arithmetic never touches a float: `19.90 + 1` as a decimal is a value that
   * prints right and compares wrong, which on a price is a customer dispute
   * nobody can reproduce.
   */
  function stepPrice(direction: 1 | -1): void {
    const unit = 10 ** currencyDigits(currency);
    const base = parsed?.ok ? parsed.minor : (variant.price?.amount ?? 0);
    setPriceDraft(plainMajor(Math.max(0, base + direction * unit), currency));
  }

  const deltaValue = Number(delta);
  const deltaShaped = delta.trim() !== '' && Number.isSafeInteger(deltaValue) && deltaValue !== 0;
  /*
   * THE FLOOR, JUDGED WHERE THE PROMISE IS MADE. `shop_inventory_on_hand_ck`
   * refuses a count below zero and the route answers 400 — so a form whose
   * arithmetic line cheerfully reads "0 available → -3 after this" is writing
   * a cheque the system is built to bounce. `available` is on_hand minus
   * reserved, so keeping IT at zero or above keeps on_hand there too; when
   * there is no stock record at all there is no floor to know, and the server
   * stays the judge.
   */
  const belowZero =
    deltaShaped &&
    deltaValue < 0 &&
    variant.available !== null &&
    variant.available + deltaValue < 0;
  const deltaOk = deltaShaped && !belowZero;

  /** One unit at a time, and the minus stops where the stock does. */
  function stepDelta(direction: 1 | -1): void {
    const base = deltaShaped ? deltaValue : 0;
    const floor = variant.available === null ? -Infinity : -variant.available;
    const next = Math.max(base + direction, floor);
    setDelta(next > 0 ? `+${next}` : String(next));
  }
  const canStepDown =
    variant.available === null || (deltaShaped ? deltaValue : 0) > -variant.available;

  const hasColourAxis =
    Object.keys(variant.optionValues ?? {}).some(isColourAxis) || variant.colorHex !== null;

  function leave(): void {
    setMode('view');
    setPriceDraft('');
    setPriceReason('');
    setDelta('');
    setStockReason('');
  }

  async function run(work: () => Promise<void>, done: string, fallback: string): Promise<void> {
    setBusy(true);
    try {
      await work();
      notify(done);
      leave();
      onChanged();
    } catch (err) {
      notify(explainVariantTrouble(err, fallback), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const savePrice = () =>
    run(
      async () => {
        if (!parsed?.ok) return;
        await shopApi.setVariantPrice(variant.id, parsed.minor, currency, priceReason.trim());
      },
      'Price set — the old one is kept in the history',
      'That price did not go through.',
    );

  const adjustStock = () =>
    run(
      async () => {
        await shopApi.adjustInventory(variant.id, deltaValue, stockReason.trim());
      },
      `Stock ${deltaValue > 0 ? 'up' : 'down'} ${Math.abs(deltaValue)}`,
      'That stock change did not go through.',
    );

  async function attachImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    try {
      // The same slot/PUT/commit the product cover uses. The id is attached
      // only after a fully successful commit, which is what the server's
      // `checkVariantImage` requires.
      const stored = await storeImageFile(file);
      await shopApi.updateVariant(variant.id, { imageId: stored.id });
      notify('Photo set');
      leave();
      onChanged();
    } catch (err) {
      notify(err instanceof ImageError ? err.message : 'That image could not be added.', {
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  const removeImage = () =>
    run(
      async () => {
        await shopApi.updateVariant(variant.id, { imageId: null });
      },
      'Photo removed',
      'That change did not go through.',
    );

  const saveColour = (hex: string | null) =>
    run(
      async () => {
        await shopApi.updateVariant(variant.id, { colorHex: hex });
        setColourOpen(false);
      },
      hex ? 'Colour code set' : 'Colour code cleared',
      'That colour code did not go through.',
    );

  /*
   * ARCHIVE / RESTORE — the existing `PATCH .../variants/:id` `status` field,
   * with no new API (issue #18). ARCHIVE DOES NOT CONFIRM: it is reversible by
   * the Restore button right beside it, and a confirmation dialog on a
   * reversible action is the thing that teaches people to click through
   * dialogs without reading them.
   */
  const archive = () =>
    run(
      async () => {
        await shopApi.updateVariant(variant.id, { status: 'discontinued' });
      },
      'Archived — restore it any time',
      'That did not go through.',
    );

  const restore = () =>
    run(
      async () => {
        await shopApi.updateVariant(variant.id, { status: 'active' });
      },
      'Restored',
      'That did not go through.',
    );

  /*
   * DELETE — the one irreversible control here, so unlike archive it DOES
   * confirm (issue #18). Only ever offered when `variant.everOrdered` is
   * false: the server refuses an ordered variant with a 409, and a control
   * that exists only to be refused is the app asking "are you sure?" about
   * something it will not do — so this hides rather than lets that 409 render.
   */
  const removeVariant = async (): Promise<void> => {
    if (
      !window.confirm(
        `Delete ${optionSummary(variant)}? This removes it completely and cannot be undone.`,
      )
    ) {
      return;
    }
    await run(
      async () => {
        await shopApi.deleteVariant(variant.id);
      },
      'Deleted',
      'That did not go through.',
    );
  };

  const available =
    variant.available === null ? 'No stock record' : `${variant.available} available`;

  return (
    <div className="vdetail">
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
        hidden
        onChange={(e) => {
          void attachImage(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      <div className="vdetail__head">
        <span className="vthumb vthumb--lg" aria-hidden="true">
          {variant.imageId ? (
            <img className="vthumb__img" src={api.imageUrl(variant.imageId)} alt="" />
          ) : variant.colorHex ? (
            <span className="vthumb__fill" style={{ backgroundColor: variant.colorHex }} />
          ) : (
            <ImagePlus className="ui-ic" aria-hidden="true" />
          )}
        </span>
        <div className="vdetail__id">
          <h3 className="vdetail__title">
            <Swatch hex={variant.colorHex} size="md" />
            {optionSummary(variant)}
          </h3>
          {/* The SKU is SHOWN, not asked for. It is the machine's name for this
              row, and a person needs to be able to read it off to a supplier —
              but never to invent it. */}
          <p className="vdetail__sku">{variant.sku}</p>
          <p className="vdetail__facts">
            <strong className="num">
              {variant.price
                ? formatMinor(variant.price.amount, variant.price.currency)
                : 'Never priced'}
            </strong>
            {' · '}
            {available}
            {variant.status === 'discontinued' && ' · discontinued'}
          </p>
          {/* Straight to THIS variant's own history. The question "why is this
              number what it is" is asked in front of the number, so the answer
              should be one click from it rather than a page away. */}
          {/* `from` is the way back: the history page has no other way to know
              which product you were reading when you clicked. */}
          <Link
            className="vdetail__history"
            to={`/shop/audit?variant=${encodeURIComponent(variant.id)}&from=${encodeURIComponent(variant.productId)}`}
          >
            <History className="ui-ic" aria-hidden="true" />
            History
          </Link>
        </div>
      </div>

      {mode === 'view' && (
        <>
          <div className="vactions">
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => setMode('price')}
            >
              <Banknote className="ui-ic" aria-hidden="true" />
              Adjust price
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => setMode('stock')}
            >
              <Boxes className="ui-ic" aria-hidden="true" />
              Adjust stock
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={() => setMode('photo')}
            >
              <ImagePlus className="ui-ic" aria-hidden="true" />
              {variant.imageId ? 'Change photo' : 'Add photo'}
            </button>
            {variant.status === 'discontinued' ? (
              <button
                type="button"
                className="btn btn--outline btn--sm"
                disabled={busy}
                onClick={() => void restore()}
              >
                <ArchiveRestore className="ui-ic" aria-hidden="true" />
                Restore
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--outline btn--sm"
                disabled={busy}
                onClick={() => void archive()}
              >
                <Archive className="ui-ic" aria-hidden="true" />
                Archive
              </button>
            )}
          </div>
          {/*
           * DELETE, PUSHED AWAY FROM THE THREE ABOVE — it is the one
           * irreversible control in this group (issue #18's UI note). Absent
           * entirely for a variant that has ever been ordered: the server
           * would answer 409, and offering a button whose only job is to
           * refuse is the app asking "are you sure?" about something it will
           * not do.
           */}
          {!variant.everOrdered && (
            <div className="vactions vactions--danger">
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={() => void removeVariant()}
              >
                <Trash2 className="ui-ic" aria-hidden="true" />
                Delete
              </button>
            </div>
          )}
          <p className="panel__note">
            {variant.price
              ? 'Price and stock changes each ask why and keep the answer — the photo is just a photo.'
              : 'Never priced — it cannot be sold until it has a price.'}
          </p>

          {hasColourAxis && (
            <div className="vcolour">
              {colourOpen ? (
                <>
                  <input
                    type="color"
                    className="cpick__well"
                    value={lastValidColour.current}
                    aria-label="Colour code"
                    onChange={(e) => setColourDraft(e.target.value.toLowerCase())}
                  />
                  <input
                    className="input input--sm cpick__hex"
                    value={colourDraft}
                    maxLength={7}
                    aria-label="Colour code as hex"
                    onChange={(e) => {
                      const raw = e.target.value.startsWith('#')
                        ? e.target.value
                        : `#${e.target.value}`;
                      setColourDraft(raw.toLowerCase());
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    disabled={busy || !/^#[0-9a-f]{6}$/i.test(colourDraft)}
                    onClick={() => void saveColour(colourDraft)}
                  >
                    Save
                  </button>
                  {variant.colorHex && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => void saveColour(null)}
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => setColourOpen(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setColourDraft(variant.colorHex ?? '#808080');
                    setColourOpen(true);
                  }}
                >
                  <Swatch hex={variant.colorHex} />
                  {variant.colorHex ? `Colour code ${variant.colorHex}` : 'Set colour code'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {mode === 'price' && (
        <AdjustForm
          reason={priceReason}
          onReason={setPriceReason}
          presets={PRICE_REASONS}
          question="Why did the price change?"
          note={
            priceError ? (
              <p className="panel__note">{priceError}</p>
            ) : priceChanged && parsed?.ok && variant.price ? (
              <Preview
                was={formatMinor(variant.price.amount, variant.price.currency)}
                now={formatMinor(parsed.minor, currency)}
                /*
                 * A rise is the RED one, matching the history page, which
                 * colours `increase` with the danger token: it is the change a
                 * customer notices and asks about. Down is the quiet direction.
                 */
                tone={parsed.minor > variant.price.amount ? 'bad' : 'good'}
                note={`${parsed.minor > variant.price.amount ? 'Increase' : 'Decrease'} of ${formatMinor(Math.abs(parsed.minor - variant.price.amount), currency)} · the old price is kept`}
              />
            ) : (
              <p className="panel__note">
                {variant.price
                  ? `Now ${formatMinor(variant.price.amount, variant.price.currency)} · prices are appended, never overwritten`
                  : 'Never priced — this sets its first price.'}
              </p>
            )
          }
          confirmLabel="Set price"
          confirmDisabled={!priceChanged || priceReason.trim() === ''}
          busy={busy}
          onConfirm={() => void savePrice()}
          onCancel={leave}
        >
          <div className="vmode__field">
            <label className="label" htmlFor={`price-${variant.id}`}>
              New price ({currency})
            </label>
            <Stepper
              id={`price-${variant.id}`}
              label="price"
              inputMode="decimal"
              value={priceDraft}
              placeholder={variant.price ? plainMajor(variant.price.amount, currency) : '0.00'}
              onType={setPriceDraft}
              onStep={stepPrice}
            />
          </div>
        </AdjustForm>
      )}

      {mode === 'stock' && (
        <AdjustForm
          reason={stockReason}
          onReason={setStockReason}
          presets={STOCK_REASONS}
          question="Why did the stock change?"
          note={
            belowZero ? (
              <p className="panel__note">
                Only {variant.available} available — you can’t write off more than there is.
              </p>
            ) : deltaOk && variant.available !== null ? (
              <Preview
                was={`${variant.available} available`}
                now={`${variant.available + deltaValue}`}
                tone={deltaValue > 0 ? 'good' : 'bad'}
                note={`${deltaValue > 0 ? `${deltaValue} in` : `${Math.abs(deltaValue)} out`} · recorded with who made it and why`}
              />
            ) : (
              <p className="panel__note">
                Plus for stock arriving, minus for stock leaving. Every change is
                recorded with who made it and why.
              </p>
            )
          }
          confirmLabel="Adjust stock"
          confirmDisabled={!deltaOk || stockReason.trim() === ''}
          busy={busy}
          onConfirm={() => void adjustStock()}
          onCancel={leave}
        >
          <div className="vmode__field">
            <label className="label" htmlFor={`stock-${variant.id}`}>
              Change by
            </label>
            <Stepper
              id={`stock-${variant.id}`}
              label="stock change"
              inputMode="numeric"
              value={delta}
              placeholder="+10"
              onType={setDelta}
              onStep={stepDelta}
              canStepDown={canStepDown}
            />
          </div>
        </AdjustForm>
      )}

      {mode === 'photo' && (
        <div className="vmode">
          <p className="panel__note">
            The photograph of THIS option — the storefront shows it when a
            customer picks the colour. No reason needed; a photo is not an
            audited number.
          </p>
          <div className="vmode__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={leave} disabled={busy}>
              Cancel
            </button>
            {variant.imageId && (
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={() => void removeImage()}
              >
                Remove photo
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? 'Uploading…' : variant.imageId ? 'Replace photo' : 'Upload photo'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- the panel

export function VariantsPanel({
  product,
  onChanged,
}: {
  product: ShopProductDetail;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [building, setBuilding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const variants = product.variants;
  const current = variants.find((v) => v.id === selected) ?? variants[0] ?? null;
  const currency = current?.price?.currency ?? 'NGN';

  async function addSingle(): Promise<void> {
    setBusy(true);
    try {
      // No options and no SKU: "it is just the one thing", said in one click.
      await shopApi.createVariant(product.id, {});
      notify('Ready to price');
      onChanged();
    } catch {
      notify('That did not go through.', { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Variants</h2>
        {variants.length > 0 && !building && (
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => setBuilding(true)}
          >
            <Plus className="ui-ic" aria-hidden="true" />
            Add options
          </button>
        )}
      </div>

      <div className="panel__body">
        {building ? (
          <OptionBuilder
            product={product}
            onDone={() => {
              setBuilding(false);
              onChanged();
            }}
            onCancel={() => setBuilding(false)}
          />
        ) : variants.length === 0 ? (
          /*
           * THE FIRST QUESTION, and it is not "what is the SKU". A shopkeeper
           * knows whether the thing comes in colours long before anybody needs
           * a code for it.
           */
          <div className="vempty">
            <p className="vempty__q">Does this come in variations?</p>
            <p className="panel__note">
              Different colours, sizes, weights — anything where the same product
              is sold in more than one form. A product sells nothing until it has
              at least one variant with a price.
            </p>
            <div className="vempty__choices">
              <button
                type="button"
                className="btn btn--outline"
                disabled={busy}
                onClick={() => void addSingle()}
              >
                No — it&rsquo;s a single item
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setBuilding(true)}
              >
                Yes — set up options
              </button>
            </div>
          </div>
        ) : (
          <div className="vsplit">
            {/* LEFT: finding. Thumbnail or swatch, what it is, and the two
                numbers you scan a list for. */}
            <ul className="vlist">
              {variants.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`vlist__item${v.id === current?.id ? ' is-active' : ''}${v.status === 'discontinued' ? ' is-discontinued' : ''}`}
                    aria-current={v.id === current?.id ? 'true' : undefined}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="vlist__thumb">
                      {v.imageId ? (
                        <img src={api.imageUrl(v.imageId)} alt="" />
                      ) : v.colorHex ? (
                        <span className="vthumb__fill" style={{ backgroundColor: v.colorHex }} />
                      ) : (
                        <ImagePlus className="ui-ic" aria-hidden="true" />
                      )}
                    </span>
                    <span className="vlist__text">
                      <span className="vlist__name">
                        {optionSummary(v)}
                        {/* THE LIST, NOT ONLY THE DETAIL PANE (issue #18) — this
                            is where somebody scans for "what is still real",
                            and the old build only said "discontinued" once a
                            row was already open. */}
                        {v.status === 'discontinued' && (
                          <span className="chip chip--discontinued vlist__badge">Archived</span>
                        )}
                      </span>
                      <span className="vlist__meta">
                        {v.price
                          ? formatMinor(v.price.amount, v.price.currency)
                          : 'No price'}
                        {' · '}
                        {v.available === null ? 'no stock record' : `${v.available} left`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {/* RIGHT: one variant — read first, change deliberately. */}
            {current && (
              <VariantCard
                key={current.id}
                variant={current}
                currency={currency}
                onChanged={onChanged}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
