import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Lock, Minus, Package, Plus, Search, Settings as SettingsIcon, X } from 'lucide-react';
import {
  moneyRefusalMessage,
  parseMajor,
  plainMajor,
  shopApi,
  type ShopBoxMode,
  type ShopBoxShortfall,
  type ShopMysteryBox,
  type ShopProduct,
  type ShopProductDetail,
} from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { dateTime } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Card } from '../ui/Card';
import { Badge, Banner, Button, EmptyState, Loading } from '../ui/primitives';
import { AffixField, Checkbox, Radio, TextField, Toggle } from '../ui/Field';
import { InfoTip } from '../ui/InfoTip';
import { MediaManager, StoredImg, type MediaValue } from '../ui/Img';
import { Modal } from '../ui/Modal';
import { RichText } from '../ui/RichText';
import { SaveBar } from '../ui/SaveBar';
import { useToast } from '../ui/Toast';
import { BoxFillModal } from './BoxFillModal';

/**
 * SETTINGS → MYSTERY BOX (migrations 1240; owner's decisions 2026-09-15).
 *
 * ONE mystery box, and it is its own thing: a name, a description, pictures, a
 * price and how many items go in each box, all set here. Until pictures and a
 * description are added, the shop shows the pool's product photos and a line
 * naming them. What can go inside is chosen product by product, variant by
 * variant; only products on sale can be added, never drafts.
 */

type List = 'main' | 'backup';
const STORE_CURRENCY = 'NGN';

interface Draft {
  enabled: boolean;
  mode: ShopBoxMode;
  shortfall: ShopBoxShortfall;
  name: string;
  /** null = the editor hasn't produced a document, so the stored one is left alone. */
  description: unknown | null;
  media: MediaValue;
  price: string;
  itemCount: string;
  ticked: Record<List, string[]>;
  /** Products shown on each list, in order — kept while editing even with nothing ticked. */
  groups: Record<List, string[]>;
}

function draftOf(view: ShopMysteryBox): Draft {
  const groups: Record<List, string[]> = { main: [], backup: [] };
  const ticked: Record<List, string[]> = { main: [], backup: [] };
  for (const item of view.items) {
    if (!item.usable) continue;
    ticked[item.list].push(item.variantId);
    if (!groups[item.list].includes(item.productId)) groups[item.list].push(item.productId);
  }
  const box = view.box;
  return {
    enabled: view.settings.enabled,
    mode: view.settings.mode,
    shortfall: view.settings.shortfall,
    name: box?.name ?? 'Mystery box',
    description: null,
    media: { coverImageId: box?.coverImageId ?? null, imageIds: box?.imageIds ?? [] },
    price: box?.priceMinor != null ? plainMajor(box.priceMinor, box.currency) : '',
    itemCount: box?.itemCount != null ? String(box.itemCount) : '3',
    ticked,
    groups,
  };
}

const sameDraft = (a: Draft, b: Draft): boolean => {
  const norm = (d: Draft) =>
    JSON.stringify({
      ...d,
      groups: undefined,
      ticked: { main: [...d.ticked.main].sort(), backup: [...d.ticked.backup].sort() },
    });
  return norm(a) === norm(b);
};

const variantLabel = (optionValues: Record<string, string>, sku: string) => {
  const values = Object.values(optionValues).filter(Boolean);
  return values.length ? values.join(' · ') : sku;
};

const MODES: { value: ShopBoxMode; label: string; hint: string }[] = [
  { value: 'pack', label: 'I pack each box', hint: 'You choose what goes in after each order comes in.' },
  { value: 'built', label: 'I pack boxes ahead', hint: 'You pack boxes before they sell. Each sale takes the next ready box.' },
  { value: 'auto', label: 'The shop picks', hint: 'When payment arrives, the shop picks items from the list and takes them out of stock.' },
];

const SHORTFALLS: { value: ShopBoxShortfall; label: string; hint: string }[] = [
  { value: 'hold', label: 'Keep the order and tell me', hint: 'The order shows that its box needs filling by hand.' },
  { value: 'backup', label: 'Use the backup items', hint: 'Fills from a second list when the main list runs out.' },
  { value: 'cancel_refund', label: 'Cancel and refund in full', hint: 'Happens automatically, with nobody clicking anything.' },
];

export default function SettingsMysteryBox() {
  const toast = useToast();
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'settings');

  const [view, setView] = useState<ShopMysteryBox | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [details, setDetails] = useState<Record<string, ShopProductDetail>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [beaten, setBeaten] = useState(false);
  const [picking, setPicking] = useState<List | null>(null);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await shopApi.getMysteryBox(signal);
      /* Only products on sale can go in a box, so only those are offered. */
      const all: ShopProduct[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const res = await shopApi.listProducts({ status: 'active', limit: 100, cursor, sort: 'alphabetical' }, signal);
        all.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      setView(next);
      setDraft(draftOf(next));
      setEditorKey((k) => k + 1);
      setProducts(all);
      setLoadError(null);
      setBeaten(false);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (!scoped) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, scoped]);

  /* Every product on a list needs its variants to show the unticked ones too. */
  const groupKey = draft ? [...draft.groups.main, ...draft.groups.backup].join('|') : '';
  useEffect(() => {
    if (!groupKey) return;
    for (const id of new Set(groupKey.split('|'))) {
      if (details[id]) continue;
      shopApi.getProduct(id).then(
        (d) => setDetails((all) => ({ ...all, [id]: d })),
        () => {},
      );
    }
  }, [groupKey, details]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const header = (
    <PageHeader
      icon={<SettingsIcon />}
      title="Mystery box"
      backTo="/settings"
      backLabel="Settings"
      titleBadge={
        view ? <Badge tone={view.settings.enabled ? 'ok' : 'neutral'}>{view.settings.enabled ? 'On sale' : 'Off'}</Badge> : undefined
      }
      subtitle="A surprise box made of products you choose."
    />
  );

  if (!scoped) {
    return (
      <div className="page">
        {header}
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don't have access to this"
            body="The mystery box is part of the shop's settings, which only the owner and developers can change."
          />
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="page">
        {header}
        <Banner tone="critical" title="Couldn’t load the mystery box" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }
  if (!view || !draft) {
    return (
      <div className="page">
        {header}
        <Loading what="the mystery box" />
      </div>
    );
  }

  const edit = (patch: Partial<Draft>) => {
    setProblem(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const dirty = !sameDraft(draft, draftOf(view)) || draft.description !== null;
  const box = view.box;
  const count = Number(draft.itemCount);
  const countOk = Number.isInteger(count) && count >= 1;

  /* Items on the main list that are in stock right now — the number "can be
     bought" divides. The server's figure also subtracts boxes already sold and
     waiting, so it is the one shown once saved. */
  const stockOf = (variantId: string): number => {
    const item = view.items.find((i) => i.variantId === variantId);
    if (item) return item.available;
    for (const d of Object.values(details)) {
      const v = d.variants.find((x) => x.id === variantId);
      if (v) return Math.max(0, v.available ?? 0);
    }
    return 0;
  };
  const unitsOn = (list: List) => draft.ticked[list].reduce((n, id) => n + stockOf(id), 0);
  const estimate =
    draft.mode === 'built'
      ? (box?.ready ?? 0)
      : countOk
        ? Math.floor((unitsOn('main') + (draft.shortfall === 'backup' ? unitsOn('backup') : 0)) / count)
        : 0;
  const canBuy = dirty || !box ? estimate : box.canBuy;
  const noOwnPictures = draft.media.coverImageId === null && draft.media.imageIds.length === 0;

  function setTicked(list: List, ids: string[], on: boolean) {
    const current = new Set(draft!.ticked[list]);
    for (const id of ids) {
      if (on) current.add(id);
      else current.delete(id);
    }
    edit({ ticked: { ...draft!.ticked, [list]: [...current] } });
  }

  async function addProducts(list: List, ids: string[]) {
    const loaded: Record<string, ShopProductDetail> = {};
    for (const id of ids) {
      if (details[id]) continue;
      try {
        loaded[id] = await shopApi.getProduct(id);
      } catch {
        /* Skipped; the rest are still added. */
      }
    }
    const all = { ...details, ...loaded };
    setDetails(all);
    const variantIds = ids.flatMap((id) => (all[id]?.variants ?? []).filter((v) => v.status === 'active').map((v) => v.id));
    setDraft((d) =>
      d
        ? {
            ...d,
            groups: { ...d.groups, [list]: [...d.groups[list], ...ids.filter((id) => !d.groups[list].includes(id))] },
            ticked: { ...d.ticked, [list]: [...new Set([...d.ticked[list], ...variantIds])] },
          }
        : d,
    );
    setProblem(null);
  }

  function removeProduct(list: List, productId: string) {
    const ids = new Set([
      ...(details[productId]?.variants.map((v) => v.id) ?? []),
      ...view!.items.filter((i) => i.productId === productId).map((i) => i.variantId),
    ]);
    edit({
      groups: { ...draft!.groups, [list]: draft!.groups[list].filter((id) => id !== productId) },
      ticked: { ...draft!.ticked, [list]: draft!.ticked[list].filter((id) => !ids.has(id)) },
    });
  }

  async function save() {
    if (!view || !draft) return;
    let priceMinor: number | null = null;
    if (draft.price.trim() !== '') {
      const parsed = parseMajor(draft.price, STORE_CURRENCY);
      if (!parsed.ok) {
        setProblem(`Price: ${moneyRefusalMessage(parsed.reason, STORE_CURRENCY)}`);
        return;
      }
      priceMinor = parsed.minor;
    }
    if (draft.itemCount.trim() !== '' && !countOk) {
      setProblem('Items per box is a whole number, 1 or more.');
      return;
    }
    if (draft.enabled && (!draft.name.trim() || priceMinor === null || !countOk)) {
      setProblem('Give the box a name, a price and a number of items before putting it on sale.');
      return;
    }
    setSaving(true);
    try {
      const next = await shopApi.saveMysteryBox({
        expectedRevision: view.settings.revision,
        enabled: draft.enabled,
        mode: draft.mode,
        shortfall: draft.shortfall,
        name: draft.name,
        description: draft.description,
        coverImageId: draft.media.coverImageId,
        imageIds: draft.media.imageIds,
        priceMinor,
        itemCount: countOk ? count : null,
        main: draft.ticked.main,
        backup: draft.shortfall === 'backup' ? draft.ticked.backup : draft.ticked.backup,
      });
      setView(next);
      setDraft(draftOf(next));
      setEditorKey((k) => k + 1);
      toast.show('Mystery box saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setBeaten(true);
      else if (cause instanceof ApiError && cause.detail === 'items') {
        setProblem('One of the ticked products is no longer on sale. Reload the page to see the current list.');
      } else {
        setProblem(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  }

  const renderGroups = (list: List) => {
    const ticked = new Set(draft.ticked[list]);
    if (draft.groups[list].length === 0) {
      return (
        <div className="mbx-empty">
          <Package aria-hidden="true" />
          <p>{list === 'main' ? 'No products yet. Add the products that can go in the box.' : 'No backup products yet.'}</p>
          <Button tone="primary" onClick={() => setPicking(list)}>
            <Plus aria-hidden="true" />
            Add products
          </Button>
        </div>
      );
    }
    return (
      <div className="stack">
        {draft.groups[list].map((productId) => {
          const detail = details[productId];
          const listed = productById.get(productId);
          const title = detail?.title ?? listed?.title ?? view.items.find((i) => i.productId === productId)?.productTitle ?? 'Product';
          const cover = detail?.coverImageId ?? listed?.coverImageId ?? null;
          const variants = (detail?.variants ?? []).filter((v) => v.status === 'active');
          const on = variants.filter((v) => ticked.has(v.id)).length;
          return (
            <section key={productId} className="mbx-group" aria-label={title}>
              <header className="mbx-group__head">
                <span className="mbx-group__thumb" aria-hidden="true">
                  {cover ? <StoredImg id={cover} /> : <Package />}
                </span>
                <span className="mbx-group__title">
                  <strong>{title}</strong>
                  <span className="muted">
                    {detail ? `${on} of ${variants.length} variants in the box` : 'Loading variants…'}
                  </span>
                </span>
                {detail ? (
                  <Button tone="plain" onClick={() => setTicked(list, variants.map((v) => v.id), on !== variants.length)}>
                    {on === variants.length ? 'Clear' : 'Select all'}
                  </Button>
                ) : null}
                <Button tone="plain" iconOnly aria-label={`Remove ${title}`} onClick={() => removeProduct(list, productId)}>
                  <X aria-hidden="true" />
                </Button>
              </header>
              <ul className="mbx-variants">
                {variants.map((v) => {
                  const stock = Math.max(0, v.available ?? 0);
                  return (
                    <li key={v.id}>
                      <label className={`mbx-variant${ticked.has(v.id) ? ' is-on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={ticked.has(v.id)}
                          onChange={(e) => setTicked(list, [v.id], e.target.checked)}
                        />
                        {v.colorHex ? <span className="slot__swatch mbx-variant__swatch" style={{ background: v.colorHex }} aria-hidden="true" /> : null}
                        <span className="mbx-variant__name">{variantLabel(v.optionValues, v.sku)}</span>
                        <Badge tone={stock === 0 ? 'critical' : stock <= 2 ? 'warn' : 'neutral'}>
                          {stock === 0 ? 'Out of stock' : `${stock} in stock`}
                        </Badge>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--s2)' }}>
          <span className="field__hint">
            {draft.ticked[list].length} {draft.ticked[list].length === 1 ? 'variant' : 'variants'} ·{' '}
            {unitsOn(list)} {unitsOn(list) === 1 ? 'item' : 'items'} in stock
          </span>
          <Button onClick={() => setPicking(list)}>
            <Plus aria-hidden="true" />
            Add products
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      {header}

      {beaten ? (
        <Banner tone="warn" title="Someone else saved these settings" action={<Button onClick={() => void load()}>Reload</Button>}>
          Reload to see their changes. What you typed here hasn’t been saved.
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="critical" title="Not saved">
          {problem}
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          <Card title="Details">
            <TextField label="Name" value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
            <div className="field">
              <span className="field__label">Description</span>
              <RichText
                key={editorKey}
                value={box ? box.description : null}
                placeholder={view.fallback.line || 'Say what makes the box worth buying.'}
                onChange={(doc) => edit({ description: doc })}
              />
              {view.fallback.line ? (
                <span className="field__hint">Left empty, the shop shows: “{view.fallback.line}”</span>
              ) : null}
            </div>
            <div className="field">
              <span className="field__label">Pictures</span>
              <MediaManager value={draft.media} onChange={(media) => edit({ media })} alt={draft.name || 'Mystery box'} />
              {noOwnPictures && view.fallback.imageIds.length > 0 ? (
                <div className="mbx-fallback">
                  <span className="field__hint">Until you add pictures, the shop shows these from the products inside:</span>
                  <div className="mbx-fallback__row">
                    {view.fallback.imageIds.slice(0, 6).map((id) => (
                      <span key={id} className="mbx-fallback__thumb">
                        <StoredImg id={id} />
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Price and contents">
            <div className="mbx-pricing">
              <AffixField
                label="Price"
                prefix="₦"
                inputMode="decimal"
                value={draft.price}
                placeholder="0"
                onChange={(e) => edit({ price: e.target.value })}
              />
              <div className="field">
                <span className="field__label mbx-label">
                  Items per box
                  <InfoTip label="What items per box means">
                    How many products go into each box a customer buys. With 3, every box holds 3 items picked from
                    the products you tick below. The same product can go in twice if it has to.
                  </InfoTip>
                </span>
                <div className="mbx-stepper">
                  <Button
                    iconOnly
                    aria-label="One fewer item"
                    disabled={!countOk || count <= 1}
                    onClick={() => edit({ itemCount: String(Math.max(1, count - 1)) })}
                  >
                    <Minus aria-hidden="true" />
                  </Button>
                  <input
                    className="input"
                    inputMode="numeric"
                    aria-label="Items per box"
                    value={draft.itemCount}
                    onChange={(e) => edit({ itemCount: e.target.value })}
                  />
                  <Button iconOnly aria-label="One more item" onClick={() => edit({ itemCount: String(countOk ? count + 1 : 1) })}>
                    <Plus aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="mbx-stat">
              <span className="mbx-stat__number num">{canBuy}</span>
              <span className="mbx-stat__text">
                <span className="mbx-label">
                  {canBuy === 1 ? 'box can be bought right now' : 'boxes can be bought right now'}
                  <InfoTip label="How this is worked out">
                    {draft.mode === 'built'
                      ? 'You pack boxes ahead, so this is how many packed boxes are ready and not already sold.'
                      : `The items in stock on your list, divided by ${countOk ? count : 'the items per box'}, less boxes already sold and waiting to be filled.${draft.shortfall === 'backup' ? ' Backup items count too.' : ''} When it reaches 0 the box shows as sold out.`}
                  </InfoTip>
                </span>
                <span className="muted">
                  {draft.mode === 'built'
                    ? `${box?.ready ?? 0} packed and ready`
                    : `${unitsOn('main')} items in stock ÷ ${countOk ? count : '—'} per box${dirty ? ' · save to update' : ''}`}
                </span>
              </span>
            </div>
          </Card>

          <Card title="What can go inside">
            <p className="field__hint">
              Add products that are on sale, then untick any variants that shouldn’t go in.
            </p>
            {renderGroups('main')}
          </Card>

          {draft.shortfall === 'backup' ? (
            <Card title="Backup items">
              <p className="field__hint">Used only when the list above runs out.</p>
              {renderGroups('backup')}
            </Card>
          ) : null}

          {draft.mode === 'built' && box ? (
            <Card title="Boxes packed ahead">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <Badge tone={box.ready === 0 ? 'critical' : 'ok'}>{box.ready} ready</Badge>
                </span>
                <Button disabled={dirty || !box.itemCount} onClick={() => setBuilding(true)}>
                  <Gift aria-hidden="true" />
                  Pack a box
                </Button>
              </div>
              {dirty ? <p className="field__hint">Save your changes before packing boxes.</p> : null}
              {view.built.map((b) => (
                <div key={b.id} className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
                  <span className="muted" style={{ fontSize: 'var(--t-md)' }}>
                    {b.items.map((i) => i.title).join(', ')}{' '}
                    <span style={{ fontSize: 'var(--t-sm)' }}>· packed {dateTime(b.filledAt)}</span>
                  </span>
                  <Button
                    tone="plain"
                    onClick={async () => {
                      try {
                        const next = await shopApi.breakUpMysteryBox(b.id);
                        setView(next);
                        toast.show('Box unpacked. Its items are back in stock.');
                      } catch (cause) {
                        toast.show(cause instanceof Error ? cause.message : 'Couldn’t unpack that box.', 'critical');
                      }
                    }}
                  >
                    Unpack
                  </Button>
                </div>
              ))}
            </Card>
          ) : null}
        </div>

        <aside className="form2__side">
          <Card title="Status">
            <Toggle label="On sale" checked={draft.enabled} onChange={(on) => edit({ enabled: on })} />
            <p className="field__hint">
              {draft.enabled
                ? 'Customers can buy the box once you save.'
                : 'Hidden from the shop. Orders already placed can still be packed and sent.'}
            </p>
          </Card>

          <Card title="Who packs the box">
            <div className="stack stack--tight">
              {MODES.map((m) => (
                <Radio key={m.value} name="box-mode" label={m.label} hint={m.hint} checked={draft.mode === m.value} onChange={() => edit({ mode: m.value })} />
              ))}
            </div>
          </Card>

          <Card title="If a box can’t be filled">
            <div className="stack stack--tight">
              {SHORTFALLS.map((s) => (
                <Radio key={s.value} name="box-shortfall" label={s.label} hint={s.hint} checked={draft.shortfall === s.value} onChange={() => edit({ shortfall: s.value })} />
              ))}
            </div>
            <p className="field__hint">
              {draft.mode === 'pack' ? 'Only used when the shop packs boxes for you.' : 'Checked each time the shop fills a paid box.'}
            </p>
          </Card>
        </aside>
      </div>

      <SaveBar
        when={dirty}
        saving={saving}
        onDiscard={() => {
          setDraft(draftOf(view));
          setEditorKey((k) => k + 1);
          setProblem(null);
        }}
        onSave={() => void save()}
      />

      {picking ? (
        <ProductPicker
          products={products.filter((p) => p.id !== box?.productId)}
          already={new Set(draft.groups[picking])}
          title={picking === 'main' ? 'Add products to the box' : 'Add backup products'}
          onClose={() => setPicking(null)}
          onAdd={(ids) => {
            const list = picking;
            setPicking(null);
            void addProducts(list, ids);
          }}
        />
      ) : null}

      {building && box?.itemCount ? (
        <BoxFillModal
          target={{ kind: 'build', sizeVariantId: box.variantId, sizeLabel: box.name }}
          itemCount={box.itemCount}
          onClose={() => setBuilding(false)}
          onDone={() => {
            setBuilding(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** A searchable list of products on sale, pick several, add them in one go. */
function ProductPicker({
  products,
  already,
  title,
  onClose,
  onAdd,
}: {
  products: ShopProduct[];
  already: Set<string>;
  title: string;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const shown = products.filter((p) => (p.title || '').toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={chosen.size === 0} onClick={() => onAdd([...chosen])}>
            {chosen.size === 0 ? 'Add products' : `Add ${chosen.size} ${chosen.size === 1 ? 'product' : 'products'}`}
          </Button>
        </>
      }
    >
      <div className="stack">
        <label className="mbx-search">
          <Search aria-hidden="true" />
          <input
            className="input"
            autoFocus
            placeholder="Search products on sale"
            aria-label="Search products on sale"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {shown.length === 0 ? (
          <p className="muted">{products.length === 0 ? 'No products are on sale yet.' : 'Nothing matches that.'}</p>
        ) : (
          <ul className="mbx-picker">
            {shown.map((p) => {
              const on = already.has(p.id);
              return (
                <li key={p.id}>
                  <div className={`mbx-picker__row${on ? ' is-disabled' : ''}`}>
                    <Checkbox
                      label={
                        <span className="mbx-picker__label">
                          <span className="mbx-group__thumb" aria-hidden="true">
                            {p.coverImageId ? <StoredImg id={p.coverImageId} /> : <Package />}
                          </span>
                          {p.title || 'Untitled product'}
                        </span>
                      }
                      hint={on ? 'Already in the box' : undefined}
                      checked={on || chosen.has(p.id)}
                      onChange={(next) => {
                        if (on) return;
                        setChosen((c) => {
                          const n = new Set(c);
                          if (next) n.add(p.id);
                          else n.delete(p.id);
                          return n;
                        });
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
