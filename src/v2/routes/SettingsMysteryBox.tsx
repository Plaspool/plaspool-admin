import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Lock, Settings as SettingsIcon, X } from 'lucide-react';
import {
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
import { Checkbox, Radio, Toggle } from '../ui/Field';
import { SaveBar } from '../ui/SaveBar';
import { SearchSelect } from '../ui/SearchSelect';
import { useToast } from '../ui/Toast';
import { BoxFillModal } from './BoxFillModal';

/**
 * SETTINGS → MYSTERY BOX (migration 1240; owner's decisions 2026-09-15).
 *
 * ONE mystery box. The switch, the product it is sold as (its variants are the
 * sizes), how many items each size holds, how contents get decided, what happens
 * when a paid box can't be filled, and the tick lists of which variants of which
 * products can go inside, plus a backup list. Everything saves together behind
 * the settings revision, so two tabs can't quietly overwrite each other.
 */

type List = 'main' | 'backup';

interface Draft {
  enabled: boolean;
  productId: string | null;
  mode: ShopBoxMode;
  shortfall: ShopBoxShortfall;
  /** Items in each size, as typed. */
  counts: Record<string, string>;
  ticked: Record<List, string[]>;
  /** Products shown on each list, in order — kept even with nothing ticked while editing. */
  groups: Record<List, string[]>;
}

function draftOf(box: ShopMysteryBox): Draft {
  const groups: Record<List, string[]> = { main: [], backup: [] };
  const ticked: Record<List, string[]> = { main: [], backup: [] };
  for (const item of box.items) {
    ticked[item.list].push(item.variantId);
    if (!groups[item.list].includes(item.productId)) groups[item.list].push(item.productId);
  }
  return {
    enabled: box.settings.enabled,
    productId: box.settings.productId,
    mode: box.settings.mode,
    shortfall: box.settings.shortfall,
    counts: Object.fromEntries(box.sizes.map((s) => [s.variantId, s.itemCount == null ? '' : String(s.itemCount)])),
    ticked,
    groups,
  };
}

const sameDraft = (a: Draft, b: Draft): boolean => {
  const norm = (d: Draft) =>
    JSON.stringify({
      ...d,
      counts: Object.fromEntries(Object.entries(d.counts).sort()),
      ticked: { main: [...d.ticked.main].sort(), backup: [...d.ticked.backup].sort() },
      groups: undefined,
    });
  return norm(a) === norm(b);
};

const variantLabel = (optionValues: Record<string, string>, sku: string) => {
  const values = Object.values(optionValues).filter(Boolean);
  return values.length ? values.join(' · ') : sku;
};

const MODES: { value: ShopBoxMode; label: string; hint: string }[] = [
  {
    value: 'pack',
    label: 'I pack it myself',
    hint: 'You choose what goes in after each order comes in.',
  },
  {
    value: 'built',
    label: 'I build boxes ahead',
    hint: 'You pack boxes before they sell. Each sale takes the next ready box.',
  },
  {
    value: 'auto',
    label: 'The shop picks at checkout',
    hint: 'When payment arrives, the shop picks items from the list and takes them out of stock.',
  },
];

const SHORTFALLS: { value: ShopBoxShortfall; label: string; hint: string }[] = [
  {
    value: 'hold',
    label: 'Keep the order and tell me',
    hint: 'The order shows that its box needs filling by hand.',
  },
  {
    value: 'backup',
    label: 'Fill from the backup items',
    hint: 'Uses the backup list below when the main list runs out.',
  },
  {
    value: 'cancel_refund',
    label: 'Cancel it and refund in full',
    hint: 'Cancels the order and refunds the customer automatically, with nobody clicking anything.',
  },
];

export default function SettingsMysteryBox() {
  const toast = useToast();
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'settings');

  const [box, setBox] = useState<ShopMysteryBox | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [details, setDetails] = useState<Record<string, ShopProductDetail>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [beaten, setBeaten] = useState(false);
  const [building, setBuilding] = useState<{ variantId: string; label: string; count: number } | null>(null);

  const need = useCallback(
    async (productId: string) => {
      if (details[productId]) return;
      try {
        const detail = await shopApi.getProduct(productId);
        setDetails((d) => ({ ...d, [productId]: detail }));
      } catch {
        /* The group still shows its ticked variants from the server's list. */
      }
    },
    [details],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await shopApi.getMysteryBox(signal);
      const all: ShopProduct[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const res = await shopApi.listProducts({ limit: 100, cursor, sort: 'alphabetical' }, signal);
        all.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      setBox(next);
      setDraft(draftOf(next));
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

  /* Every product on either list, and the box product, needs its variants. */
  useEffect(() => {
    if (!draft) return;
    const ids = new Set([...draft.groups.main, ...draft.groups.backup, ...(draft.productId ? [draft.productId] : [])]);
    for (const id of ids) void need(id);
  }, [draft, need]);

  const titleOf = useMemo(() => new Map(products.map((p) => [p.id, p.title])), [products]);

  if (!scoped) {
    return (
      <div className="page">
        <PageHeader icon={<SettingsIcon />} title="Mystery box" backTo="/settings" backLabel="Settings" />
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
        <PageHeader icon={<SettingsIcon />} title="Mystery box" backTo="/settings" backLabel="Settings" />
        <Banner tone="critical" title="Couldn’t load the mystery box" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }

  if (!box || !draft) {
    return (
      <div className="page">
        <PageHeader icon={<SettingsIcon />} title="Mystery box" backTo="/settings" backLabel="Settings" />
        <Loading what="the mystery box" />
      </div>
    );
  }

  const edit = (patch: Partial<Draft>) => {
    setProblem(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const dirty = !sameDraft(draft, draftOf(box));
  const boxProduct = draft.productId ? details[draft.productId] : undefined;
  const sizeVariants = (boxProduct?.variants ?? []).filter((v) => v.status === 'active');
  const savedSize = (variantId: string) =>
    box.settings.productId === draft.productId ? box.sizes.find((s) => s.variantId === variantId) : undefined;

  function setTicked(list: List, variantId: string, on: boolean) {
    const current = draft!.ticked[list];
    edit({
      ticked: {
        ...draft!.ticked,
        [list]: on ? [...new Set([...current, variantId])] : current.filter((id) => id !== variantId),
      },
    });
  }

  async function addProduct(list: List, productId: string) {
    if (!productId || draft!.groups[list].includes(productId)) return;
    let detail = details[productId];
    if (!detail) {
      try {
        detail = await shopApi.getProduct(productId);
        setDetails((d) => ({ ...d, [productId]: detail! }));
      } catch (cause) {
        toast.show(cause instanceof Error ? cause.message : 'Couldn’t load that product.', 'critical');
        return;
      }
    }
    /* Adding a product ticks all of its active variants; untick what shouldn't go in. */
    const variantIds = detail.variants.filter((v) => v.status === 'active').map((v) => v.id);
    setDraft((d) =>
      d
        ? {
            ...d,
            groups: { ...d.groups, [list]: [...d.groups[list], productId] },
            ticked: { ...d.ticked, [list]: [...new Set([...d.ticked[list], ...variantIds])] },
          }
        : d,
    );
  }

  function removeProduct(list: List, productId: string) {
    const variantIds = new Set(
      [
        ...(details[productId]?.variants.map((v) => v.id) ?? []),
        ...box!.items.filter((i) => i.productId === productId).map((i) => i.variantId),
      ],
    );
    edit({
      groups: { ...draft!.groups, [list]: draft!.groups[list].filter((id) => id !== productId) },
      ticked: { ...draft!.ticked, [list]: draft!.ticked[list].filter((id) => !variantIds.has(id)) },
    });
  }

  async function save() {
    if (!box || !draft) return;
    if (draft.enabled && !draft.productId) {
      setProblem('Choose the product the mystery box is sold as before switching it on.');
      return;
    }
    const sizes: { variantId: string; itemCount: number | null }[] = [];
    for (const v of sizeVariants) {
      const raw = (draft.counts[v.id] ?? '').trim();
      if (raw === '') {
        sizes.push({ variantId: v.id, itemCount: null });
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        setProblem(`${variantLabel(v.optionValues, v.sku)}: items in each box is a whole number, 1 or more.`);
        return;
      }
      sizes.push({ variantId: v.id, itemCount: n });
    }
    setSaving(true);
    try {
      const next = await shopApi.saveMysteryBox({
        expectedRevision: box.settings.revision,
        enabled: draft.enabled,
        productId: draft.productId,
        mode: draft.mode,
        shortfall: draft.shortfall,
        sizes,
        main: draft.ticked.main,
        backup: draft.ticked.backup,
      });
      setBox(next);
      setDraft(draftOf(next));
      toast.show('Mystery box saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setBeaten(true);
      } else if (cause instanceof ApiError && cause.detail === 'box_has_open_orders') {
        setProblem(
          'The current mystery box still has paid orders waiting to be filled. Fill or cancel those before choosing a different product.',
        );
      } else {
        setProblem(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  }

  const productOptions = products
    .filter((p) => p.id !== draft.productId)
    .map((p) => ({ value: p.id, label: p.title || 'Untitled product', meta: p.status === 'active' ? undefined : p.status }));

  const renderList = (list: List) => {
    const tickedSet = new Set(draft.ticked[list]);
    const units = draft.ticked[list].reduce((n, id) => {
      const fromServer = box.items.find((i) => i.variantId === id);
      const fromDetail = Object.values(details)
        .flatMap((d) => d.variants)
        .find((v) => v.id === id);
      return n + Math.max(0, fromServer?.available ?? fromDetail?.available ?? 0);
    }, 0);
    return (
      <div className="stack">
        <div style={{ maxWidth: '22rem' }}>
          <SearchSelect
            label={list === 'main' ? 'Add a product to the list' : 'Add a backup product'}
            value={''}
            options={productOptions.filter((o) => !draft.groups[list].includes(o.value))}
            placeholder="Search products"
            onChange={(id) => void addProduct(list, id)}
          />
        </div>
        {draft.groups[list].length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            {list === 'main'
              ? 'Nothing can go in the box yet. Add a product, then untick any variants that shouldn’t.'
              : 'No backup items.'}
          </p>
        ) : (
          draft.groups[list].map((productId) => {
            const detail = details[productId];
            const serverRows = box.items.filter((i) => i.productId === productId && i.list === list);
            const rows = detail
              ? detail.variants
                  .filter((v) => v.status === 'active' || tickedSet.has(v.id))
                  .map((v) => ({
                    variantId: v.id,
                    label: variantLabel(v.optionValues, v.sku),
                    available: v.available ?? 0,
                    colorHex: v.colorHex,
                  }))
              : serverRows.map((i) => ({
                  variantId: i.variantId,
                  label: variantLabel(i.optionValues, i.sku),
                  available: i.available,
                  colorHex: i.colorHex,
                }));
            const title = detail?.title ?? serverRows[0]?.productTitle ?? titleOf.get(productId) ?? 'Product';
            return (
              <div key={productId} className="stack stack--tight" style={{ borderTop: '1px solid var(--border-sub)', paddingTop: 'var(--s3)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 'var(--t-md)' }}>{title}</strong>
                  <Button tone="plain" iconOnly aria-label={`Remove ${title} from the list`} onClick={() => removeProduct(list, productId)}>
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {rows.map((r) => (
                  <Checkbox
                    key={r.variantId}
                    label={
                      <span className="row" style={{ gap: 'var(--s2)', display: 'inline-flex' }}>
                        {r.colorHex ? (
                          <span className="slot__swatch" style={{ background: r.colorHex, width: '0.875rem', height: '0.875rem' }} aria-hidden="true" />
                        ) : null}
                        {r.label}
                      </span>
                    }
                    hint={r.available > 0 ? `${r.available} in stock` : 'None in stock'}
                    checked={tickedSet.has(r.variantId)}
                    onChange={(on) => setTicked(list, r.variantId, on)}
                  />
                ))}
              </div>
            );
          })
        )}
        <p className="field__hint">
          {draft.ticked[list].length} {draft.ticked[list].length === 1 ? 'variant' : 'variants'} ticked,{' '}
          {units} {units === 1 ? 'item' : 'items'} in stock.
        </p>
      </div>
    );
  };

  return (
    <div className="page">
      <PageHeader
        icon={<SettingsIcon />}
        title="Mystery box"
        backTo="/settings"
        backLabel="Settings"
        titleBadge={<Badge tone={box.settings.enabled ? 'ok' : 'neutral'}>{box.settings.enabled ? 'On' : 'Off'}</Badge>}
        subtitle="One mystery box for the shop: what it's sold as, what can go inside, and how it gets filled."
      />

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

      <div className="stack">
        <Card title="Mystery box">
          <Toggle
            label="Sell the mystery box"
            checked={draft.enabled}
            onChange={(on) => edit({ enabled: on })}
          />
          <p className="field__hint">
            Switching it off hides the product from the shop. Orders already placed can still be filled and sent.
          </p>
        </Card>

        <Card title="Sold as">
          <div style={{ maxWidth: '22rem' }}>
            <SearchSelect
              label="Product"
              value={draft.productId ?? ''}
              options={[
                ...(draft.productId
                  ? [{ value: draft.productId, label: titleOf.get(draft.productId) ?? box.settings.productTitle ?? 'Product' }]
                  : []),
                ...productOptions,
              ]}
              placeholder="Search products"
              onChange={(id) => {
                edit({ productId: id || null });
                if (id) void need(id);
              }}
            />
          </div>
          <p className="field__hint">
            The box keeps that product’s photos, price and page. Its variants are the box sizes.
            {box.settings.productStatus && box.settings.productId === draft.productId
              ? ` It is ${box.settings.productStatus === 'active' ? 'on sale' : `a ${box.settings.productStatus}`} right now.`
              : ''}
          </p>
          {draft.productId ? (
            sizeVariants.length === 0 ? (
              <p className="muted">
                {boxProduct ? 'This product has no active variants yet. Add sizes on the product first.' : 'Loading sizes…'}
              </p>
            ) : (
              <div className="tscroll">
                <table className="table">
                  <caption className="sr">Box sizes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Size</th>
                      <th scope="col">Items in each box</th>
                      <th scope="col">Can sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sizeVariants.map((v) => {
                      const saved = savedSize(v.id);
                      return (
                        <tr key={v.id}>
                          <td className="cell--primary">
                            <span className="idcell">
                              <span className="idcell__text">
                                <span className="idcell__title">{variantLabel(v.optionValues, v.sku)}</span>
                                <span className="idcell__meta mono">{v.sku}</span>
                              </span>
                            </span>
                          </td>
                          <td>
                            <input
                              className="input"
                              style={{ width: '5rem' }}
                              inputMode="numeric"
                              aria-label={`Items in each ${variantLabel(v.optionValues, v.sku)} box`}
                              value={draft.counts[v.id] ?? ''}
                              placeholder="—"
                              onChange={(e) => edit({ counts: { ...draft.counts, [v.id]: e.target.value } })}
                            />
                          </td>
                          <td>
                            {saved && saved.itemCount ? (
                              <Badge tone={saved.canFill === 0 ? 'critical' : saved.canFill <= 2 ? 'warn' : 'ok'}>
                                {saved.canFill === 0 ? 'Sold out' : saved.canFill === 1 ? '1 more box' : `${saved.canFill} more boxes`}
                              </Badge>
                            ) : (
                              <span className="muted">Save to see</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </Card>

        <Card title="How the contents get decided">
          <div className="stack stack--tight">
            {MODES.map((m) => (
              <Radio
                key={m.value}
                name="box-mode"
                label={m.label}
                hint={m.hint}
                checked={draft.mode === m.value}
                onChange={() => edit({ mode: m.value })}
              />
            ))}
          </div>
        </Card>

        <Card title="If a paid box can't be filled">
          <div className="stack stack--tight">
            {SHORTFALLS.map((s) => (
              <Radio
                key={s.value}
                name="box-shortfall"
                label={s.label}
                hint={s.hint}
                checked={draft.shortfall === s.value}
                onChange={() => edit({ shortfall: s.value })}
              />
            ))}
          </div>
          <p className="field__hint">
            {draft.mode === 'pack'
              ? 'You pack every box yourself, so this only matters if you switch to building ahead or letting the shop pick.'
              : 'Checked each time the shop fills a paid box by itself.'}
          </p>
        </Card>

        <Card title="Can go inside">{renderList('main')}</Card>

        <Card title="Backup items">
          {draft.shortfall !== 'backup' ? (
            <p className="field__hint">Only used when “Fill from the backup items” is chosen above.</p>
          ) : null}
          {renderList('backup')}
        </Card>

        {draft.mode === 'built' && box.settings.productId === draft.productId && draft.productId ? (
          <Card title="Boxes built ahead">
            {dirty ? (
              <p className="field__hint">Save your changes before building boxes.</p>
            ) : null}
            {sizeVariants.length === 0 ? (
              <p className="muted">No sizes yet.</p>
            ) : (
              sizeVariants.map((v) => {
                const saved = savedSize(v.id);
                const label = variantLabel(v.optionValues, v.sku);
                const ready = box.built.filter((b) => b.sizeVariantId === v.id);
                return (
                  <div key={v.id} className="stack stack--tight" style={{ borderTop: '1px solid var(--border-sub)', paddingTop: 'var(--s3)' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        <strong style={{ fontSize: 'var(--t-md)' }}>{label}</strong>{' '}
                        <Badge tone={ready.length === 0 ? 'critical' : 'ok'}>{ready.length} ready</Badge>
                      </span>
                      <Button
                        disabled={dirty || !saved?.itemCount}
                        onClick={() => setBuilding({ variantId: v.id, label, count: saved!.itemCount! })}
                      >
                        <Gift aria-hidden="true" />
                        Build a box
                      </Button>
                    </div>
                    {!saved?.itemCount ? (
                      <p className="field__hint">Set how many items go in this size, then save.</p>
                    ) : null}
                    {ready.map((b) => (
                      <div key={b.id} className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
                        <span className="muted" style={{ fontSize: 'var(--t-md)' }}>
                          {b.items.map((i) => i.title).join(', ')}{' '}
                          <span style={{ fontSize: 'var(--t-sm)' }}>· built {dateTime(b.filledAt)}</span>
                        </span>
                        <Button
                          tone="plain"
                          onClick={async () => {
                            try {
                              const next = await shopApi.breakUpMysteryBox(b.id);
                              setBox(next);
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
                  </div>
                );
              })
            )}
          </Card>
        ) : null}
      </div>

      <SaveBar
        when={dirty}
        saving={saving}
        onDiscard={() => {
          setDraft(draftOf(box));
          setProblem(null);
        }}
        onSave={() => void save()}
      />

      {building ? (
        <BoxFillModal
          target={{ kind: 'build', sizeVariantId: building.variantId, sizeLabel: building.label }}
          itemCount={building.count}
          onClose={() => setBuilding(null)}
          onDone={() => {
            setBuilding(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
