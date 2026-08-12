import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, ImagePlus, Plus, X } from 'lucide-react';
import {
  shopApi,
  formatMinor,
  moneyRefusalMessage,
  parseMajor,
  type ShopProductDetail,
  type ShopVariant,
} from '../data/api-shop';
import { api } from '../data/api';
import { ImageError, storeImageFile } from '../data/images';
import { Select } from '../components/ui/Select';
import { useToast } from '../components/Toast';
import './shop.css';

/**
 * Variants, rebuilt around the question a person actually starts from.
 *
 * WHAT WAS WRONG. The old panel opened with a text box demanding a SKU. You
 * could not say "it comes in eight colours" — you had to invent
 * `WOOD-175-EBY-1KG`, press Add, then repeat that seven more times, and only
 * then start naming colours and quantities. That is the computer's filing done
 * by hand, before any of the information a shopkeeper actually has.
 *
 * WHAT IT ASKS INSTEAD. Does this come in variations? If yes, WHICH KINDS —
 * colour, size, whatever this product varies by — and then the VALUES of each.
 * The combinations follow from that, and so do the SKUs (`server/shop/catalog/
 * sku.ts` derives them; supplying one still wins). One decision per screenful,
 * in the order somebody already knows the answers.
 *
 * WHY MASTER-DETAIL AND NOT A TABLE. A row of inputs per variant means eight
 * colours is eight price boxes, eight stock boxes and eight reason boxes on one
 * screen — every one of them a chance to type into the wrong row, and none of
 * them wide enough to read. The list on the left is for FINDING the variant;
 * the panel on the right is for CHANGING it, one at a time, with room to say
 * why.
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
 * A reason picker: six presets, or your own words.
 *
 * The free-text box only appears once "Something else" is chosen, so the common
 * path is one click and the uncommon one is still open.
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
  /**
   * The ACCESSIBLE NAME, and it must say which change it explains.
   *
   * Both pickers on this panel used to be called "Why", which is fine to look
   * at — each sits beside the field it belongs to — and useless to listen to:
   * a screen reader announces two controls with the same name and no way to
   * tell the price one from the stock one. The visible placeholder stays short.
   */
  label: string;
}) {
  const isPreset = presets.includes(value);
  const [custom, setCustom] = useState(!isPreset && value !== '');
  const selection = custom ? OTHER : isPreset ? value : '';

  return (
    <div className="vreason">
      <Select
        label={label}
        size="sm"
        value={selection}
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
          { value: '', label: 'Why…' },
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

// ------------------------------------------------------- the option builder

/** The axes people actually use, so the common case is a click. */
const AXIS_PRESETS = ['Colour', 'Size', 'Material', 'Weight', 'Style', 'Finish'];

interface Axis {
  name: string;
  values: string[];
}

/** Every combination of the axes, in a stable order. */
function combinations(axes: Axis[]): Record<string, string>[] {
  const usable = axes.filter((a) => a.name.trim() !== '' && a.values.length > 0);
  if (usable.length === 0) return [];
  return usable.reduce<Record<string, string>[]>(
    (acc, axis) =>
      acc.flatMap((row) => axis.values.map((v) => ({ ...row, [axis.name.trim()]: v }))),
    [{}],
  );
}

function AxisEditor({
  axis,
  onChange,
  onRemove,
}: {
  axis: Axis;
  onChange: (a: Axis) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState('');

  function add(): void {
    const value = draft.trim();
    // Case-insensitive, because "Black" and "black" are one colour and two
    // variants — and the second is a SKU collision waiting to be explained.
    if (!value || axis.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange({ ...axis, values: [...axis.values, value] });
    setDraft('');
  }

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

      <div className="vaxis__values">
        {axis.values.map((v) => (
          <span key={v} className="chip chip--value">
            {v}
            <button
              type="button"
              className="chip__x"
              aria-label={`Remove ${v}`}
              onClick={() => onChange({ ...axis, values: axis.values.filter((x) => x !== v) })}
            >
              <X className="ui-ic" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          className="input input--sm vaxis__add"
          value={draft}
          maxLength={200}
          placeholder={axis.values.length ? 'And…' : 'Black'}
          aria-label={`Add a ${axis.name || 'value'}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds, and does NOT submit the product form around it.
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
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
    () => new Set(product.variants.map((v) => JSON.stringify(sortedOptions(v.optionValues)))),
    [product.variants],
  );
  // Combinations this product already has are not offered again — re-running
  // the builder to add one colour should create one variant, not twelve.
  const fresh = rows.filter((r) => !existing.has(JSON.stringify(sortedOptions(r))));

  async function create(): Promise<void> {
    setBusy(true);
    let made = 0;
    try {
      for (const optionValues of fresh) {
        // No SKU: the server derives one per combination. That is the whole
        // reason this screen can ask about colours instead of codes.
        await shopApi.createVariant(product.id, { optionValues });
        made += 1;
      }
      notify(made === 1 ? 'One variant added' : `${made} variants added`);
      onDone();
    } catch (err) {
      notify(
        made === 0
          ? 'Nothing was created.'
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
          onChange={(next) => setAxes(axes.map((a, j) => (i === j ? next : a)))}
          onRemove={() => setAxes(axes.filter((_, j) => j !== i))}
        />
      ))}

      <div className="vbuild__add">
        {AXIS_PRESETS.filter((p) => !axes.some((a) => a.name === p)).map((p) => (
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
          {fresh.length === 0
            ? 'Add at least one value to see what this makes.'
            : `This makes ${fresh.length} ${fresh.length === 1 ? 'variant' : 'variants'}` +
              (rows.length !== fresh.length
                ? ` · ${rows.length - fresh.length} already exist`
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

// ------------------------------------------------------------- the detail pane

function VariantDetail({
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
  const [imageBusy, setImageBusy] = useState(false);

  const [priceDraft, setPriceDraft] = useState(
    variant.price ? formatMinor(variant.price.amount, variant.price.currency).replace(/[^\d.]/g, '') : '',
  );
  const [priceReason, setPriceReason] = useState('');
  const [delta, setDelta] = useState('');
  const [stockReason, setStockReason] = useState('');
  const [busy, setBusy] = useState<'price' | 'stock' | null>(null);

  const parsed = priceDraft.trim() === '' ? null : parseMajor(priceDraft, currency);
  const priceError = parsed && !parsed.ok ? moneyRefusalMessage(parsed.reason, currency) : null;
  const priceChanged = parsed?.ok && parsed.minor !== (variant.price?.amount ?? -1);

  const deltaValue = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isSafeInteger(deltaValue) && deltaValue !== 0;

  async function attachImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setImageBusy(true);
    try {
      // The same slot/PUT/commit the product cover uses. The id is attached
      // only after a fully successful commit, which is what the server's
      // `checkVariantImage` requires.
      const stored = await storeImageFile(file);
      await shopApi.updateVariant(variant.id, { imageId: stored.id });
      notify('Image set');
      onChanged();
    } catch (err) {
      notify(err instanceof ImageError ? err.message : 'That image could not be added.', {
        tone: 'danger',
      });
    } finally {
      setImageBusy(false);
    }
  }

  async function savePrice(): Promise<void> {
    if (!parsed?.ok) return;
    setBusy('price');
    try {
      await shopApi.setVariantPrice(variant.id, parsed.minor, currency, priceReason);
      notify('Price set — the old one is kept in the history');
      setPriceReason('');
      onChanged();
    } catch {
      notify('That price did not go through.', { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  async function adjust(): Promise<void> {
    if (!deltaOk || stockReason.trim() === '') return;
    setBusy('stock');
    try {
      await shopApi.adjustInventory(variant.id, deltaValue, stockReason.trim());
      notify(`Stock ${deltaValue > 0 ? 'up' : 'down'} ${Math.abs(deltaValue)}`);
      setDelta('');
      setStockReason('');
      onChanged();
    } catch {
      notify('That stock change did not go through.', { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="vdetail">
      <div className="vdetail__head">
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
        <button
          type="button"
          className="vthumb vthumb--lg"
          disabled={imageBusy}
          onClick={() => fileInput.current?.click()}
          aria-label={variant.imageId ? 'Replace this image' : 'Add an image'}
        >
          {variant.imageId ? (
            <img className="vthumb__img" src={api.imageUrl(variant.imageId)} alt="" />
          ) : (
            <ImagePlus className="ui-ic" aria-hidden="true" />
          )}
        </button>
        <div>
          <h3 className="vdetail__title">{optionSummary(variant)}</h3>
          {/* The SKU is SHOWN, not asked for. It is the machine's name for this
              row, and a person needs to be able to read it off to a supplier —
              but never to invent it. */}
          <p className="vdetail__sku">{variant.sku}</p>
          <p className="pager__note">
            {variant.available === null
              ? 'No stock record'
              : `${variant.available} available`}
            {variant.status === 'discontinued' && ' · discontinued'}
          </p>
          {/* Straight to THIS variant's own history. The question "why is this
              number what it is" is asked in front of the number, so the answer
              should be one click from it rather than a page away. */}
          <Link className="vdetail__history" to={`/shop/audit?variant=${encodeURIComponent(variant.id)}`}>
            <History className="ui-ic" aria-hidden="true" />
            History
          </Link>
        </div>
      </div>

      <div className="vdetail__field">
        <label className="label" htmlFor={`price-${variant.id}`}>
          Price
        </label>
        <div className="vdetail__row">
          <input
            id={`price-${variant.id}`}
            className="input input--sm vdetail__num"
            inputMode="decimal"
            value={priceDraft}
            placeholder="0.00"
            onChange={(e) => setPriceDraft(e.target.value)}
          />
          <ReasonPicker
            presets={PRICE_REASONS}
            value={priceReason}
            onChange={setPriceReason}
            label="Why the price changed"
          />
          <button
            type="button"
            className="btn btn--outline btn--sm"
            disabled={busy !== null || !priceChanged}
            onClick={() => void savePrice()}
          >
            Set
          </button>
        </div>
        <p className="panel__note">
          {priceError ??
            (variant.price
              ? `Now ${formatMinor(variant.price.amount, variant.price.currency)} · prices are appended, never overwritten`
              : 'Never priced — it cannot be sold')}
        </p>
      </div>

      <div className="vdetail__field">
        <label className="label" htmlFor={`stock-${variant.id}`}>
          Stock
        </label>
        <div className="vdetail__row">
          <input
            id={`stock-${variant.id}`}
            className="input input--sm vdetail__num"
            inputMode="numeric"
            value={delta}
            placeholder="+10"
            onChange={(e) => setDelta(e.target.value)}
          />
          <ReasonPicker
            presets={STOCK_REASONS}
            value={stockReason}
            onChange={setStockReason}
            label="Why the stock changed"
          />
          <button
            type="button"
            className="btn btn--outline btn--sm"
            disabled={busy !== null || !deltaOk || stockReason.trim() === ''}
            onClick={() => void adjust()}
          >
            Adjust
          </button>
        </div>
        <p className="panel__note">
          A reason is required, and it is kept — every change to this number is
          recorded with who made it and why.
        </p>
      </div>
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
            {/* LEFT: finding. Thumbnail, what it is, and the two numbers you
                scan a list for. */}
            <ul className="vlist">
              {variants.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className={`vlist__item${v.id === current?.id ? ' is-active' : ''}`}
                    aria-current={v.id === current?.id ? 'true' : undefined}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="vlist__thumb">
                      {v.imageId ? (
                        <img src={api.imageUrl(v.imageId)} alt="" />
                      ) : (
                        <ImagePlus className="ui-ic" aria-hidden="true" />
                      )}
                    </span>
                    <span className="vlist__text">
                      <span className="vlist__name">{optionSummary(v)}</span>
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

            {/* RIGHT: changing. One variant, with room to say why. */}
            {current && (
              <VariantDetail
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
