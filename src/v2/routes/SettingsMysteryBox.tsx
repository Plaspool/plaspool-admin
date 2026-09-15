import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Flame,
  Gift,
  ImagePlus,
  Lock,
  Minus,
  Package,
  PackageX,
  Plus,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  TrendingUp,
  X,
} from 'lucide-react';
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
import {
  BOX_PAGE_DEFAULTS,
  BOX_PAGE_LIMITS,
  resolveBoxCues,
  type BoxCue,
  type BoxCueKind,
  type BoxPage,
} from '../../../shared/commerce/mystery-box';
import { dateTime, money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Card } from '../ui/Card';
import { Badge, Banner, Button, EmptyState, Loading, type BadgeTone } from '../ui/primitives';
import { AffixField, Checkbox, MoneyField, Radio, Segmented, TextArea, TextField, Toggle } from '../ui/Field';
import { InfoTip } from '../ui/InfoTip';
import { MediaManager, PhotoPicker, StoredImg, type MediaValue } from '../ui/Img';
import { Modal } from '../ui/Modal';
import { RichText } from '../ui/RichText';
import { SaveBar } from '../ui/SaveBar';
import { useToast } from '../ui/Toast';
import { BoxFillModal } from './BoxFillModal';

/**
 * SETTINGS → MYSTERY BOX (migrations 1240 and 1260; owner's decisions 2026-09-15).
 *
 * ONE mystery box, and it is its own thing: a name, a description, an overview,
 * pictures and its SIZES ("5kg", "10kg"), each with its own price, items per box,
 * weight, shipping weight and photo, all set here.
 * Until pictures and a description are added, the shop shows the pool's product
 * photos and a line naming them. What can go inside is chosen product by
 * product, variant by variant; only products on sale can be added, never drafts.
 *
 * THE SHOP PAGE IS EDITED HERE TOO (1260): the "How it works" steps, and the cues
 * that tell shoppers to buy while the box is still here. The preview runs the
 * same `resolveBoxCues` the server runs for the shop, so it can't disagree.
 */

type List = 'main' | 'backup';
const STORE_CURRENCY = 'NGN';
const HOUR = 60 * 60 * 1000;

/** One size as the form holds it: everything as typed. */
interface SizeDraft {
  /** Stable while editing: the variant id, or a local one for a new size. */
  key: string;
  variantId: string | null;
  size: string;
  itemCount: string;
  price: string;
  /** Kilograms, as typed. */
  weight: string;
  shippingWeight: string;
  imageId: string | null;
}

let localKey = 0;
const blankSize = (itemCount = '3'): SizeDraft => ({
  key: `new-${(localKey += 1)}`,
  variantId: null,
  size: '',
  itemCount,
  price: '',
  weight: '',
  shippingWeight: '',
  imageId: null,
});

/** 5000 → "5", 6250 → "6.25": grams as kilograms, worked on digits, never a float. */
function gramsToKg(grams: number | null): string {
  if (grams === null) return '';
  const rest = String(grams % 1000).padStart(3, '0').replace(/0+$/, '');
  return rest ? `${Math.floor(grams / 1000)}.${rest}` : String(Math.floor(grams / 1000));
}

/** "6.25" → 6250. Null for a blank box; undefined for text that isn't a weight. */
function kgToGrams(text: string): number | null | undefined {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return null;
  const m = /^(\d*)(?:\.(\d{0,3}))?$/.exec(t);
  if (!m || (m[1] === '' && !m[2])) return undefined;
  const grams = Number(m[1] || '0') * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  return grams <= 10_000_000 ? grams : undefined;
}

const MAX_SIZES = 10;

interface Draft {
  enabled: boolean;
  mode: ShopBoxMode;
  shortfall: ShopBoxShortfall;
  name: string;
  /** null = the editor hasn't produced a document, so the stored one is left alone. */
  description: unknown | null;
  overview: string;
  media: MediaValue;
  sizes: SizeDraft[];
  page: BoxPage;
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
    overview: box?.overview ?? '',
    media: { coverImageId: box?.coverImageId ?? null, imageIds: box?.imageIds ?? [] },
    sizes:
      box && box.sizes.length > 0
        ? box.sizes.map((z) => ({
            key: z.variantId,
            variantId: z.variantId,
            size: z.size ?? '',
            itemCount: z.itemCount != null ? String(z.itemCount) : '',
            price: z.priceMinor != null ? plainMajor(z.priceMinor, box.currency) : '',
            weight: gramsToKg(z.weightGrams),
            shippingWeight: gramsToKg(z.shippingWeightGrams),
            imageId: z.imageId,
          }))
        : [blankSize()],
    page: view.settings.page ?? BOX_PAGE_DEFAULTS,
    ticked,
    groups,
  };
}

const sameDraft = (a: Draft, b: Draft): boolean => {
  const norm = (d: Draft) =>
    JSON.stringify({
      ...d,
      groups: undefined,
      /* A local key is not a change, and the boxes show "200,000.00" and "6.250";
         what matters is the amount. */
      sizes: d.sizes.map(({ key: _key, ...z }) => ({
        ...z,
        price: z.price.replace(/[\s,]/g, ''),
        weight: String(kgToGrams(z.weight) ?? z.weight),
        shippingWeight: String(kgToGrams(z.shippingWeight) ?? z.shippingWeight),
      })),
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
  const [building, setBuilding] = useState<string | null>(null);
  const [photoFor, setPhotoFor] = useState<string | null>(null);
  /* Field errors wait for a first save, so adding a size isn't a wall of red. */
  const [tried, setTried] = useState(false);

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
  const editPage = (patch: (page: BoxPage) => BoxPage) => {
    setProblem(null);
    setDraft((d) => (d ? { ...d, page: patch(d.page) } : d));
  };
  const dirty = !sameDraft(draft, draftOf(view)) || draft.description !== null;
  const box = view.box;
  /* A PRODUCT SITS ON ONE LIST (owner's decision 2026-09-15): the backup is a
     different product, never more of the same one. The server holds the same
     rule, and ignores a backup product that is also on the main list. */
  const mainProducts = new Set(draft.groups.main);
  const productOfVariant = (variantId: string): string | undefined =>
    view.items.find((i) => i.variantId === variantId)?.productId ??
    Object.values(details).find((d) => d.variants.some((v) => v.id === variantId))?.id;
  const countsAsBackup = (variantId: string) => !mainProducts.has(productOfVariant(variantId) ?? '');
  const titleOf = (productId: string): string =>
    details[productId]?.title ??
    productById.get(productId)?.title ??
    view.items.find((i) => i.productId === productId)?.productTitle ??
    'Product';
  const shortTitle = (productId: string) => titleOf(productId).split(' - ')[0].trim();
  /* Backup products that are ALSO on the main list: saved before the rule, or
     left behind by a move. They don't count, and the card says so. */
  const overlapping = draft.groups.backup.filter((id) => mainProducts.has(id));

  /* Items on a list that are in stock right now — the number "can be bought"
     divides. The server's figure also subtracts boxes already sold and waiting,
     so it is the one shown once saved. */
  const stockOf = (variantId: string): number => {
    const item = view.items.find((i) => i.variantId === variantId);
    if (item) return item.available;
    for (const d of Object.values(details)) {
      const v = d.variants.find((x) => x.id === variantId);
      if (v) return Math.max(0, v.available ?? 0);
    }
    return 0;
  };
  const tickedOn = (list: List) => draft.ticked[list].filter((id) => list === 'main' || countsAsBackup(id));
  const unitsOn = (list: List) => tickedOn(list).reduce((n, id) => n + stockOf(id), 0);
  const mainUnits = unitsOn('main');
  const backupUnits = draft.shortfall === 'backup' ? unitsOn('backup') : 0;
  const noOwnPictures = draft.media.coverImageId === null && draft.media.imageIds.length === 0;

  /* What one item on the main list weighs, on average: the basis for each size's
     suggested weight and shipping weight. Every filament today is a 1kg spool. */
  const poolWeights = (() => {
    const shown: number[] = [];
    const ship: number[] = [];
    for (const id of draft.ticked.main) {
      const v = Object.values(details)
        .flatMap((d) => d.variants)
        .find((x) => x.id === id);
      if (!v) continue;
      if (v.weightGrams != null) shown.push(v.weightGrams);
      const shipping = v.shippingWeightGrams ?? v.weightGrams;
      if (shipping != null) ship.push(shipping);
    }
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return { shown: avg(shown), ship: avg(ship) };
  })();

  const sizeFacts = (z: SizeDraft) => {
    const saved = z.variantId ? box?.sizes.find((x) => x.variantId === z.variantId) : undefined;
    const count = Number(z.itemCount);
    const countOk = z.itemCount.trim() !== '' && Number.isInteger(count) && count >= 1;
    const estimate =
      draft.mode === 'built' ? (saved?.ready ?? 0) : countOk ? Math.floor((mainUnits + backupUnits) / count) : 0;
    return {
      saved,
      count,
      countOk,
      canBuy: dirty || !saved ? estimate : saved.canBuy,
      /* A box is filled to the count its size says, so the count stays put while
         boxes of it are paid for and waiting, in a checkout, or packed ahead. */
      locked: saved ? saved.owed > 0 || saved.ready > 0 : false,
      price: z.price.trim() === '' ? null : parseMajor(z.price, STORE_CURRENCY),
      weight: kgToGrams(z.weight),
      ship: kgToGrams(z.shippingWeight),
    };
  };
  const sizeName = (z: SizeDraft, i: number) => z.size.trim() || (draft.sizes.length > 1 ? `Size ${i + 1}` : 'The box');
  const folded = draft.sizes.map((z) => z.size.trim().toLowerCase());
  const nameProblem = (i: number): string | null => {
    if (draft.sizes.length < 2) return null;
    if (folded[i] === '') return tried ? 'Give each size a name, like 5kg.' : null;
    return folded.indexOf(folded[i]) !== i ? 'Another size already has this name.' : null;
  };
  const removedSizes = (box?.sizes ?? []).filter((x) => !draft.sizes.some((z) => z.variantId === x.variantId));

  function editSize(key: string, patch: Partial<SizeDraft>) {
    setProblem(null);
    setDraft((d) => (d ? { ...d, sizes: d.sizes.map((z) => (z.key === key ? { ...z, ...patch } : z)) } : d));
  }
  function moveSize(key: string, by: -1 | 1) {
    const i = draft!.sizes.findIndex((z) => z.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= draft!.sizes.length) return;
    const next = [...draft!.sizes];
    [next[i], next[j]] = [next[j], next[i]];
    edit({ sizes: next });
  }
  function addSize() {
    const last = draft!.sizes[draft!.sizes.length - 1];
    const lastCount = last ? Number(last.itemCount) : NaN;
    /* 5kg then 10kg: the next size starts at double the last one. */
    const count = Number.isInteger(lastCount) && lastCount >= 1 ? String(Math.min(lastCount * 2, 1000)) : '3';
    edit({ sizes: [...draft!.sizes, blankSize(count)] });
  }
  /* Puts a removed size back where it was, counted among the sizes still there. */
  function undoRemove(variantId: string) {
    const original = draftOf(view!).sizes;
    const at = original.findIndex((z) => z.variantId === variantId);
    if (at < 0) return;
    const before = new Set(original.slice(0, at).map((z) => z.variantId));
    const index = draft!.sizes.filter((z) => z.variantId !== null && before.has(z.variantId)).length;
    const next = [...draft!.sizes];
    next.splice(index, 0, original[at]);
    edit({ sizes: next });
  }

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
    setDraft((d) => {
      if (!d) return d;
      const other: List = list === 'main' ? 'backup' : 'main';
      const fresh = ids.filter((id) => !d.groups[list].includes(id) && !d.groups[other].includes(id));
      const variantIds = fresh.flatMap((id) =>
        (all[id]?.variants ?? []).filter((v) => v.status === 'active').map((v) => v.id),
      );
      return {
        ...d,
        groups: { ...d.groups, [list]: [...d.groups[list], ...fresh] },
        ticked: { ...d.ticked, [list]: [...new Set([...d.ticked[list], ...variantIds])] },
      };
    });
    setProblem(null);
  }

  const variantIdsOf = (productId: string) =>
    new Set([
      ...(details[productId]?.variants.map((v) => v.id) ?? []),
      ...view!.items.filter((i) => i.productId === productId).map((i) => i.variantId),
    ]);

  function removeProducts(list: List, productIds: string[]) {
    const gone = new Set(productIds.flatMap((id) => [...variantIdsOf(id)]));
    edit({
      groups: { ...draft!.groups, [list]: draft!.groups[list].filter((id) => !productIds.includes(id)) },
      ticked: { ...draft!.ticked, [list]: draft!.ticked[list].filter((id) => !gone.has(id)) },
    });
  }
  const removeProduct = (list: List, productId: string) => removeProducts(list, [productId]);

  /* Moves a product to the other list with the variants it had ticked; whatever
     the other list held for that product is replaced. */
  function moveProduct(from: List, productId: string) {
    const to: List = from === 'main' ? 'backup' : 'main';
    const ids = variantIdsOf(productId);
    const moving = draft!.ticked[from].filter((id) => ids.has(id));
    edit({
      groups: {
        ...draft!.groups,
        [from]: draft!.groups[from].filter((id) => id !== productId),
        [to]: draft!.groups[to].includes(productId) ? draft!.groups[to] : [...draft!.groups[to], productId],
      },
      ticked: {
        ...draft!.ticked,
        [from]: draft!.ticked[from].filter((id) => !ids.has(id)),
        [to]: [...draft!.ticked[to].filter((id) => !ids.has(id)), ...moving],
      },
    });
    toast.show(to === 'backup' ? `${shortTitle(productId)} moved to the backup list` : `${shortTitle(productId)} moved to the main list`);
  }

  async function save() {
    if (!view || !draft) return;
    setTried(true);
    const sizes = [];
    for (const [i, z] of draft.sizes.entries()) {
      const f = sizeFacts(z);
      const label = sizeName(z, i);
      if (f.price !== null && !f.price.ok) {
        setProblem(`${label}: ${moneyRefusalMessage(f.price.reason, STORE_CURRENCY)}`);
        return;
      }
      if (z.itemCount.trim() !== '' && !f.countOk) {
        setProblem(`${label}: items per box is a whole number, 1 or more.`);
        return;
      }
      if (f.weight === undefined || f.ship === undefined) {
        setProblem(`${label}: enter weights in kilograms, like 5 or 6.25.`);
        return;
      }
      sizes.push({
        variantId: z.variantId,
        size: z.size.trim(),
        itemCount: f.countOk ? f.count : null,
        priceMinor: f.price?.ok ? f.price.minor : null,
        weightGrams: f.weight,
        shippingWeightGrams: f.ship,
        imageId: z.imageId,
      });
    }
    if (draft.sizes.some((_, i) => nameProblem(i) !== null) || (draft.sizes.length > 1 && folded.some((n) => n === ''))) {
      setProblem('Give every size its own name, like 5kg and 10kg.');
      return;
    }
    if (draft.enabled && (!draft.name.trim() || sizes.some((z) => z.priceMinor === null || z.itemCount === null))) {
      setProblem('Give the box a name, and every size a price and a number of items, before putting it on sale.');
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
        overview: draft.overview.trim(),
        page: {
          howItWorks: {
            title: draft.page.howItWorks.title.trim(),
            steps: draft.page.howItWorks.steps.map((s) => s.trim()).filter(Boolean),
          },
          cues: draft.page.cues,
        },
        coverImageId: draft.media.coverImageId,
        imageIds: draft.media.imageIds,
        sizes,
        main: draft.ticked.main,
        backup: tickedOn('backup'),
      });
      setView(next);
      setDraft(draftOf(next));
      setEditorKey((k) => k + 1);
      setTried(false);
      toast.show('Mystery box saved');
    } catch (cause) {
      const said: Record<string, string> = {
        items: 'One of the ticked products is no longer on sale. Reload the page to see the current list.',
        size_names: 'Give every size its own name, like 5kg and 10kg.',
        size_count_locked:
          'Boxes of that size were just paid for or packed, so its items per box can’t change now. Reload to see them.',
        size_in_use: 'A size you removed has boxes paid for or packed, so it can’t be removed yet. Reload to see them.',
        imageId: 'A size’s photo didn’t finish uploading. Pick it again.',
        box_incomplete: 'Give the box a name, and every size a price and a number of items, before putting it on sale.',
      };
      if (cause instanceof ApiError && cause.status === 409) setBeaten(true);
      else if (cause instanceof ApiError && cause.detail && said[cause.detail]) {
        setProblem(said[cause.detail]);
      } else {
        setProblem(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  }

  const renderGroups = (list: List) => {
    const ticked = new Set(draft.ticked[list]);
    /* Products on sale that aren't on either list yet. */
    const spare = products.filter(
      (p) => p.id !== box?.productId && !draft.groups.main.includes(p.id) && !draft.groups.backup.includes(p.id),
    );
    if (draft.groups[list].length === 0) {
      const nothingLeft = list === 'backup' && spare.length === 0;
      return (
        <div className="mbx-empty">
          <Package aria-hidden="true" />
          <p>
            {list === 'main'
              ? 'No products yet. Add the products that can go in the box.'
              : nothingLeft
                ? 'Every product on sale is on the main list. Choose “Move to backup” on one above to keep it for when the main list runs out.'
                : 'No backup products yet. Add products that aren’t on the main list.'}
          </p>
          {nothingLeft ? null : (
            <Button tone="primary" onClick={() => setPicking(list)}>
              <Plus aria-hidden="true" />
              Add products
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="stack">
        {draft.groups[list].map((productId) => {
          const detail = details[productId];
          const listed = productById.get(productId);
          const title = titleOf(productId);
          const cover = detail?.coverImageId ?? listed?.coverImageId ?? null;
          const variants = (detail?.variants ?? []).filter((v) => v.status === 'active');
          /* A backup product that is also on the main list isn't used; its tiles show why. */
          const overlap = list === 'backup' && mainProducts.has(productId);
          const open = overlap ? [] : variants;
          const on = open.filter((v) => ticked.has(v.id)).length;
          return (
            <section key={productId} className="mbx-group" aria-label={title}>
              <header className="mbx-group__head">
                <span className="mbx-group__thumb" aria-hidden="true">
                  {cover ? <StoredImg id={cover} /> : <Package />}
                </span>
                <span className="mbx-group__title">
                  <strong>{title}</strong>
                  <span className="muted">
                    {overlap
                      ? 'Also on the main list, so it isn’t used as backup'
                      : !detail
                        ? 'Loading variants…'
                        : `${on} of ${open.length} ${open.length === 1 ? 'variant' : 'variants'} in the ${list === 'main' ? 'box' : 'backup'}`}
                  </span>
                </span>
                {detail && open.length > 0 ? (
                  <Button tone="plain" onClick={() => setTicked(list, open.map((v) => v.id), on !== open.length)}>
                    {on === open.length ? 'Clear' : 'Select all'}
                  </Button>
                ) : null}
                {list === 'main' && draft.shortfall === 'backup' ? (
                  <Button tone="plain" onClick={() => moveProduct('main', productId)}>
                    <ArrowDown aria-hidden="true" />
                    Move to backup
                  </Button>
                ) : null}
                {list === 'backup' && !overlap ? (
                  <Button tone="plain" onClick={() => moveProduct('backup', productId)}>
                    <ArrowUp aria-hidden="true" />
                    Move to main list
                  </Button>
                ) : null}
                <Button tone="plain" iconOnly aria-label={`Remove ${title}`} onClick={() => removeProduct(list, productId)}>
                  <X aria-hidden="true" />
                </Button>
              </header>
              <ul className="mbx-variants">
                {variants.map((v) => {
                  const stock = Math.max(0, v.available ?? 0);
                  const taken = overlap;
                  const isOn = !taken && ticked.has(v.id);
                  return (
                    <li key={v.id}>
                      <label className={`mbx-variant${isOn ? ' is-on' : ''}${taken ? ' is-taken' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={taken}
                          onChange={(e) => setTicked(list, [v.id], e.target.checked)}
                        />
                        {v.colorHex ? <span className="slot__swatch mbx-variant__swatch" style={{ background: v.colorHex }} aria-hidden="true" /> : null}
                        <span className="mbx-variant__name">{variantLabel(v.optionValues, v.sku)}</span>
                        {taken ? (
                          <Badge tone="neutral">On the main list</Badge>
                        ) : (
                          <Badge tone={stock === 0 ? 'critical' : stock <= 2 ? 'warn' : 'neutral'}>
                            {stock === 0 ? 'Out of stock' : `${stock} in stock`}
                          </Badge>
                        )}
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
            {tickedOn(list).length} {tickedOn(list).length === 1 ? 'variant' : 'variants'} · {unitsOn(list)}{' '}
            {unitsOn(list) === 1 ? 'item' : 'items'} in stock
          </span>
          <Button disabled={spare.length === 0} onClick={() => setPicking(list)}>
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
            <TextField label="Name" value={draft.name} maxLength={200} onChange={(e) => edit({ name: e.target.value })} />
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
            <TextArea
              label="Overview"
              rows={3}
              value={draft.overview}
              maxLength={500}
              placeholder={box?.overviewFallback || view.fallback.line || 'A short summary of the box.'}
              hint={`A short summary near the top of the box’s page. Left empty, the shop uses the start of the description.${draft.overview.length > 0 ? ` ${draft.overview.length}/500` : ''}`}
              onChange={(e) => edit({ overview: e.target.value })}
            />
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

          <Card
            title="Sizes"
            action={
              <Button tone="plain" disabled={draft.sizes.length >= MAX_SIZES} onClick={addSize}>
                <Plus aria-hidden="true" />
                Add a size
              </Button>
            }
          >
            <p className="field__hint">
              Each size has its own price and number of items, like a 5kg box with 5 spools and a 10kg box with 10.
              Shoppers pick a size on the box’s page.
            </p>
            {draft.sizes.map((z, i) => {
              const f = sizeFacts(z);
              const label = sizeName(z, i);
              const suggestShown =
                f.countOk && poolWeights.shown !== null ? gramsToKg(f.count * poolWeights.shown) : undefined;
              const suggestShip =
                f.countOk && poolWeights.ship !== null ? gramsToKg(f.count * poolWeights.ship) : undefined;
              return (
                <section key={z.key} className="mbx-size" aria-label={label}>
                  <button
                    type="button"
                    className="mbx-size__photo"
                    aria-label={z.imageId ? `Change the photo for ${label}` : `Add a photo for ${label}`}
                    onClick={() => setPhotoFor(z.key)}
                  >
                    {z.imageId ? (
                      <StoredImg id={z.imageId} alt="" />
                    ) : (
                      <>
                        <ImagePlus aria-hidden="true" />
                        <span>Photo</span>
                      </>
                    )}
                  </button>
                  <div className="mbx-size__fields">
                    <TextField
                      label="Size name"
                      value={z.size}
                      maxLength={40}
                      placeholder={draft.sizes.length > 1 ? 'e.g. 5kg' : 'e.g. 5kg (optional)'}
                      error={nameProblem(i)}
                      onChange={(e) => editSize(z.key, { size: e.target.value })}
                    />
                    <MoneyField
                      label="Price"
                      currency={STORE_CURRENCY}
                      value={z.price}
                      placeholder="0.00"
                      error={
                        f.price !== null && !f.price.ok
                          ? moneyRefusalMessage(f.price.reason, STORE_CURRENCY)
                          : tried && draft.enabled && f.price === null
                            ? 'Needed to put the box on sale.'
                            : null
                      }
                      onChange={(e) => editSize(z.key, { price: e.target.value })}
                    />
                    <div className="field">
                      <span className="field__label mbx-label">
                        Items per box
                        <InfoTip label="What items per box means">
                          How many products go into each box of this size. With 5, every box holds 5 items picked
                          from the products you tick below. The same product can go in twice if it has to.
                        </InfoTip>
                      </span>
                      <div className="mbx-stepper">
                        <Button
                          iconOnly
                          aria-label={`One fewer item in ${label}`}
                          disabled={f.locked || !f.countOk || f.count <= 1}
                          onClick={() => editSize(z.key, { itemCount: String(Math.max(1, f.count - 1)) })}
                        >
                          <Minus aria-hidden="true" />
                        </Button>
                        <input
                          className="input"
                          inputMode="numeric"
                          aria-label={`Items per box in ${label}`}
                          value={z.itemCount}
                          disabled={f.locked}
                          onChange={(e) => editSize(z.key, { itemCount: e.target.value })}
                        />
                        <Button
                          iconOnly
                          aria-label={`One more item in ${label}`}
                          disabled={f.locked}
                          onClick={() => editSize(z.key, { itemCount: String(f.countOk ? f.count + 1 : 1) })}
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                      </div>
                      {f.locked ? (
                        <span className="field__hint">
                          Fixed while {f.saved!.owed > 0 ? `${f.saved!.owed} paid ${f.saved!.owed === 1 ? 'box waits' : 'boxes wait'} to be packed` : `${f.saved!.ready} packed ${f.saved!.ready === 1 ? 'box is' : 'boxes are'} ready`}.
                        </span>
                      ) : null}
                    </div>
                    <AffixField
                      label="Weight"
                      suffix="kg"
                      inputMode="decimal"
                      value={z.weight}
                      hint="Shown on the shop."
                      error={f.weight === undefined ? 'Enter kilograms, like 5 or 6.25.' : null}
                      suggestion={suggestShown}
                      onSuggest={(v) => editSize(z.key, { weight: v })}
                      onChange={(e) => editSize(z.key, { weight: e.target.value })}
                    />
                    <AffixField
                      label="Shipping weight"
                      suffix="kg"
                      inputMode="decimal"
                      value={z.shippingWeight}
                      hint={
                        suggestShip
                          ? `Prices delivery. About ${suggestShip} kg for ${f.count} ${f.count === 1 ? 'item' : 'items'} at ${gramsToKg(poolWeights.ship)} kg each. Blank uses the weight.`
                          : 'Prices delivery. Blank uses the weight.'
                      }
                      error={f.ship === undefined ? 'Enter kilograms, like 5 or 6.25.' : null}
                      suggestion={suggestShip}
                      onSuggest={(v) => editSize(z.key, { shippingWeight: v })}
                      onChange={(e) => editSize(z.key, { shippingWeight: e.target.value })}
                    />
                  </div>
                  <footer className="mbx-size__foot">
                    <span className="mbx-size__stat">
                      <strong className="num">{f.canBuy}</strong>{' '}
                      {f.canBuy === 1 ? 'box can be bought now' : 'boxes can be bought now'}
                      {f.saved && f.saved.soldLast24Hours > 0 ? ` · ${f.saved.soldLast24Hours} sold today` : ''}
                      {dirty ? ' · save to update' : ''}
                    </span>
                    <span className="mbx-size__acts">
                      <Button tone="plain" iconOnly aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => moveSize(z.key, -1)}>
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        tone="plain"
                        iconOnly
                        aria-label={`Move ${label} down`}
                        disabled={i === draft.sizes.length - 1}
                        onClick={() => moveSize(z.key, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        tone="plain"
                        disabled={draft.sizes.length === 1 || f.locked}
                        title={
                          draft.sizes.length === 1
                            ? 'The box needs at least one size'
                            : f.locked
                              ? 'Boxes of this size are paid for or packed'
                              : undefined
                        }
                        onClick={() => edit({ sizes: draft.sizes.filter((x) => x.key !== z.key) })}
                      >
                        <X aria-hidden="true" />
                        Remove
                      </Button>
                    </span>
                  </footer>
                </section>
              );
            })}
            {removedSizes.map((x) => (
              <Banner
                key={x.variantId}
                tone="warn"
                title={`${x.size ?? 'A size'} will be removed when you save`}
                action={<Button onClick={() => undoRemove(x.variantId)}>Undo</Button>}
              >
                {x.everOrdered
                  ? 'Customers have bought it before, so it’s taken off the shop and kept on their orders.'
                  : 'Nobody has bought it yet, so it’s deleted.'}
              </Banner>
            ))}
            <p className="field__hint mbx-label">
              Every size shares the same stock: {mainUnits} {mainUnits === 1 ? 'item' : 'items'} on the list
              {draft.shortfall === 'backup' ? ` + ${backupUnits} backup` : ''}.
              <InfoTip label="How sizes share stock">
                Each size can be bought while there are enough items for one more box. Selling a 10-item box uses 10
                items, so the smaller sizes go down too. Boxes already sold and waiting to be packed are counted
                first.
              </InfoTip>
            </p>
          </Card>

          <Card title="What can go inside">
            <p className="field__hint">
              Add products that are on sale, then untick any variants that shouldn’t go in.
            </p>
            {renderGroups('main')}
          </Card>

          {draft.shortfall === 'backup' ? (
            <Card title="Backup items">
              <p className="field__hint">
                Used only when the list above runs out. Each product goes on one list only, so the backup is always
                something different.
              </p>
              {overlapping.length > 0 ? (
                <Banner
                  tone="warn"
                  title={overlapping.length === 1 ? 'A product is on both lists' : `${overlapping.length} products are on both lists`}
                  action={
                    <Button onClick={() => removeProducts('backup', overlapping)}>
                      {overlapping.length === 1 ? 'Remove it from backup' : 'Remove them from backup'}
                    </Button>
                  }
                >
                  {listSentence(overlapping.map(shortTitle))} {overlapping.length === 1 ? 'is' : 'are'} on the main list
                  too, so {overlapping.length === 1 ? 'it isn’t' : 'they aren’t'} used as backup. Move a product here from
                  the main list instead.
                </Banner>
              ) : null}
              {renderGroups('backup')}
            </Card>
          ) : null}

          <CuesCard
            page={draft.page}
            onChange={editPage}
            name={draft.name}
            sizes={draft.sizes.map((z, i) => {
              const f = sizeFacts(z);
              return {
                key: z.key,
                label: draft.sizes.length > 1 || z.size.trim() ? sizeName(z, i) : '',
                priceMinor: f.price?.ok ? f.price.minor : null,
                canBuy: f.canBuy,
                soldLast24Hours: f.saved?.soldLast24Hours ?? 0,
              };
            })}
            onSaleSince={view.settings.enabled ? view.settings.onSaleSince : null}
          />

          <HowItWorksCard page={draft.page} onChange={editPage} />

          {draft.mode === 'built' && box ? (
            <Card title="Boxes packed ahead">
              {box.sizes.map((z) => (
                <div key={z.variantId} className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
                  <span className="row" style={{ gap: 'var(--s2)' }}>
                    <strong>{z.size ?? box.name}</strong>
                    <Badge tone={z.ready === 0 ? 'critical' : 'ok'}>{z.ready} ready</Badge>
                  </span>
                  <Button disabled={dirty || !z.itemCount} onClick={() => setBuilding(z.variantId)}>
                    <Gift aria-hidden="true" />
                    Pack a {z.size ?? 'box'}
                  </Button>
                </div>
              ))}
              {dirty ? <p className="field__hint">Save your changes before packing boxes.</p> : null}
              {view.built.map((b) => (
                <div key={b.id} className="row" style={{ justifyContent: 'space-between', gap: 'var(--s3)' }}>
                  <span className="muted" style={{ fontSize: 'var(--t-md)' }}>
                    {box.sizes.length > 1 ? `${box.sizes.find((z) => z.variantId === b.sizeVariantId)?.size ?? 'Box'}: ` : ''}
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
                ? view.settings.enabled && view.settings.onSaleSince
                  ? `On sale since ${dateTime(view.settings.onSaleSince)}.`
                  : 'Customers can buy the box once you save.'
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
          unavailable={
            new Map<string, Unavailable>([
              ...draft.groups[picking].map((id): [string, Unavailable] => [
                id,
                { here: true, hint: picking === 'main' ? 'Already in the box' : 'Already a backup' },
              ]),
              ...draft.groups[picking === 'main' ? 'backup' : 'main'].map((id): [string, Unavailable] => [
                id,
                {
                  here: false,
                  hint: picking === 'main' ? 'On the backup list. Move it from there.' : 'On the main list. Move it from there.',
                },
              ]),
            ])
          }
          title={picking === 'main' ? 'Add products to the box' : 'Add backup products'}
          onClose={() => setPicking(null)}
          onAdd={(ids) => {
            const list = picking;
            setPicking(null);
            void addProducts(list, ids);
          }}
        />
      ) : null}

      {(() => {
        const size = building ? box?.sizes.find((z) => z.variantId === building) : undefined;
        return size?.itemCount ? (
          <BoxFillModal
            target={{
              kind: 'build',
              sizeVariantId: size.variantId,
              sizeLabel: size.size ? `${box!.name} · ${size.size}` : box!.name,
            }}
            itemCount={size.itemCount}
            onClose={() => setBuilding(null)}
            onDone={() => {
              setBuilding(null);
              void load();
            }}
          />
        ) : null;
      })()}

      {(() => {
        const size = photoFor ? draft.sizes.find((z) => z.key === photoFor) : undefined;
        if (!size) return null;
        const label = sizeName(size, draft.sizes.indexOf(size));
        return (
          <Modal
            title={`Photo for ${label}`}
            onClose={() => setPhotoFor(null)}
            footer={
              <Button tone="primary" onClick={() => setPhotoFor(null)}>
                Done
              </Button>
            }
          >
            <div className="stack">
              <PhotoPicker
                value={size.imageId}
                onChange={(imageId) => editSize(size.key, { imageId })}
                choices={[...(draft.media.coverImageId ? [draft.media.coverImageId] : []), ...draft.media.imageIds]}
                alt={label}
              />
              <p className="field__hint">
                Shown when a shopper picks this size. Pick one of the box’s pictures, or upload one.
              </p>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

/* ── Cues ───────────────────────────────────────────────────────────────── */

type Scenario = 'now' | 'few' | 'sold_out';

const CUE_TONE: Record<BoxCueKind, BadgeTone> = {
  just_dropped: 'info',
  low_stock: 'warn',
  selling_fast: 'ok',
  sold_out: 'critical',
};

/**
 * The cues, each with its switch, its threshold and its words, beside a preview
 * of the box as a shopper sees it. "Right now" uses the real numbers; the other
 * two stage a moment so every line can be read before it is live.
 */
interface PreviewSize {
  key: string;
  /** Empty for a box with one unnamed size. */
  label: string;
  priceMinor: number | null;
  canBuy: number;
  soldLast24Hours: number;
}

function CuesCard({
  page,
  onChange,
  name,
  sizes,
  onSaleSince,
}: {
  page: BoxPage;
  onChange: (patch: (page: BoxPage) => BoxPage) => void;
  name: string;
  sizes: PreviewSize[];
  onSaleSince: number | null;
}) {
  const [scenario, setScenario] = useState<Scenario>('now');
  const [sizeKey, setSizeKey] = useState<string | null>(null);
  /* The cues are worked out per size, from that size's own numbers. */
  const picked = sizes.find((z) => z.key === sizeKey) ?? sizes[0];
  const size = picked?.label ?? '';
  const priceMinor = picked?.priceMinor ?? null;
  const canBuy = picked?.canBuy ?? 0;
  const soldLast24Hours = picked?.soldLast24Hours ?? 0;
  const now = Date.now();
  const { cues } = page;
  const cue = <K extends keyof BoxPage['cues']>(key: K, patch: Partial<BoxPage['cues'][K]>) =>
    onChange((p) => ({ ...p, cues: { ...p.cues, [key]: { ...p.cues[key], ...patch } } }));

  const facts =
    scenario === 'now'
      ? { available: canBuy, soldLast24Hours, onSaleSince: onSaleSince ?? now - 5 * 60 * 1000, now }
      : scenario === 'few'
        ? {
            available: Math.max(1, Math.min(3, cues.lowStock.threshold)),
            soldLast24Hours: Math.max(soldLast24Hours, cues.sellingFast.minimum),
            onSaleSince: now - 3 * HOUR,
            now,
          }
        : { available: 0, soldLast24Hours: Math.max(soldLast24Hours, cues.sellingFast.minimum), onSaleSince: now - 3 * HOUR, now };
  const shown = resolveBoxCues(page, facts);
  const changed = JSON.stringify(cues) !== JSON.stringify(BOX_PAGE_DEFAULTS.cues);

  return (
    <Card
      title="Buy-now cues"
      action={
        changed ? (
          <Button tone="plain" onClick={() => onChange((p) => ({ ...p, cues: BOX_PAGE_DEFAULTS.cues }))}>
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        ) : undefined
      }
    >
      <p className="field__hint">
        Short lines on the box’s page that tell shoppers to get it while it’s here. Each one shows only when it’s true.
      </p>

      <div className="mbx-preview" aria-live="polite">
        <div className="mbx-preview__bar">
          <Segmented<Scenario>
            label="Preview"
            value={scenario}
            options={[
              { value: 'now', label: 'Right now' },
              { value: 'few', label: 'Almost gone' },
              { value: 'sold_out', label: 'Sold out' },
            ]}
            onChange={setScenario}
          />
          {sizes.length > 1 ? (
            <Segmented<string>
              label="Size"
              value={picked?.key ?? ''}
              options={sizes.map((z) => ({ value: z.key, label: z.label }))}
              onChange={setSizeKey}
              collapse
            />
          ) : null}
        </div>
        <div className="mbx-preview__shop">
          <span className="mbx-preview__tag">
            <Gift aria-hidden="true" />
            Mystery box
          </span>
          <strong className="mbx-preview__name">
            {name.trim() || 'Mystery box'}
            {size.trim() ? <span className="muted"> · {size.trim()}</span> : null}
          </strong>
          <span className="mbx-preview__price num">{priceMinor === null ? '₦—' : money(priceMinor, STORE_CURRENCY)}</span>
          {shown.length === 0 ? (
            <span className="muted mbx-preview__none">No cue shows at this moment.</span>
          ) : (
            <ul className="mbx-preview__cues">
              {shown.map((c: BoxCue) => (
                <li key={c.kind}>
                  <Badge tone={CUE_TONE[c.kind]}>{c.text}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {scenario === 'now' && onSaleSince === null ? (
          <span className="field__hint">The box is off, so this shows it as if it went on sale a few minutes ago.</span>
        ) : null}
      </div>

      <div className="mbx-cues">
        <CueRow
          icon={<Flame />}
          title="Few left"
          enabled={cues.lowStock.enabled}
          onToggle={(enabled) => cue('lowStock', { enabled })}
          rule={
            <>
              Show when{' '}
              <CountInput
                label="Boxes left"
                value={cues.lowStock.threshold}
                max={BOX_PAGE_LIMITS.threshold}
                onChange={(threshold) => cue('lowStock', { threshold })}
              />{' '}
              or fewer boxes are left
            </>
          }
          text={cues.lowStock.text}
          placeholder={BOX_PAGE_DEFAULTS.cues.lowStock.text}
          tokens="{count} becomes the number left. A big number, like 1000, shows it all the time."
          onText={(text) => cue('lowStock', { text })}
        />
        <CueRow
          icon={<Clock />}
          title="Just dropped"
          enabled={cues.justDropped.enabled}
          onToggle={(enabled) => cue('justDropped', { enabled })}
          rule={
            <>
              Show for{' '}
              <CountInput
                label="Hours"
                value={cues.justDropped.hours}
                max={BOX_PAGE_LIMITS.hours}
                onChange={(hours) => cue('justDropped', { hours })}
              />{' '}
              hours after the box goes on sale
            </>
          }
          text={cues.justDropped.text}
          placeholder={BOX_PAGE_DEFAULTS.cues.justDropped.text}
          tokens="{time} becomes how long ago, like “2 hours ago”."
          onText={(text) => cue('justDropped', { text })}
        />
        <CueRow
          icon={<TrendingUp />}
          title="Selling fast"
          enabled={cues.sellingFast.enabled}
          onToggle={(enabled) => cue('sellingFast', { enabled })}
          rule={
            <>
              Show once{' '}
              <CountInput
                label="Boxes sold"
                value={cues.sellingFast.minimum}
                max={BOX_PAGE_LIMITS.minimum}
                onChange={(minimum) => cue('sellingFast', { minimum })}
              />{' '}
              or more have sold in the last 24 hours
            </>
          }
          text={cues.sellingFast.text}
          placeholder={BOX_PAGE_DEFAULTS.cues.sellingFast.text}
          tokens="{count} becomes how many sold."
          onText={(text) => cue('sellingFast', { text })}
        />
        <CueRow
          icon={<PackageX />}
          title="Sold out"
          enabled={cues.soldOut.enabled}
          onToggle={(enabled) => cue('soldOut', { enabled })}
          rule={<>Shown instead of the others when no more boxes can be bought</>}
          text={cues.soldOut.text}
          placeholder={BOX_PAGE_DEFAULTS.cues.soldOut.text}
          onText={(text) => cue('soldOut', { text })}
        />
      </div>
    </Card>
  );
}

function CueRow({
  icon,
  title,
  enabled,
  onToggle,
  rule,
  text,
  placeholder,
  tokens,
  onText,
}: {
  icon: ReactNode;
  title: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  rule: ReactNode;
  text: string;
  placeholder: string;
  tokens?: string;
  onText: (text: string) => void;
}) {
  return (
    <section className={`mbx-cue${enabled ? '' : ' is-off'}`} aria-label={title}>
      <div className="mbx-cue__head">
        <span className="mbx-cue__icon" aria-hidden="true">
          {icon}
        </span>
        <strong className="mbx-cue__title">{title}</strong>
        <Toggle label={<span className="sr">{`Show “${title}”`}</span>} checked={enabled} onChange={onToggle} />
      </div>
      {enabled ? (
        <div className="mbx-cue__body">
          <p className="mbx-cue__rule">{rule}</p>
          <TextField
            label="Words"
            value={text}
            maxLength={BOX_PAGE_LIMITS.cueText}
            placeholder={placeholder}
            hint={tokens}
            onChange={(e) => onText(e.target.value)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** A small whole-number box that only reports numbers it can use. */
function CountInput({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <input
      className="input mbx-count"
      inputMode="numeric"
      aria-label={label}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(String(value));
      }}
      onChange={(e) => {
        const next = e.target.value.replace(/[^\d]/g, '');
        setText(next);
        const n = Number(next);
        if (next !== '' && Number.isInteger(n) && n >= 1 && n <= max) onChange(n);
      }}
    />
  );
}

/* ── How it works ───────────────────────────────────────────────────────── */

function HowItWorksCard({ page, onChange }: { page: BoxPage; onChange: (patch: (page: BoxPage) => BoxPage) => void }) {
  const how = page.howItWorks;
  const set = (patch: Partial<BoxPage['howItWorks']>) => onChange((p) => ({ ...p, howItWorks: { ...p.howItWorks, ...patch } }));
  const steps = how.steps;
  const move = (from: number, to: number) => {
    const next = [...steps];
    const [step] = next.splice(from, 1);
    next.splice(to, 0, step);
    set({ steps: next });
  };
  const changed = JSON.stringify(how) !== JSON.stringify(BOX_PAGE_DEFAULTS.howItWorks);
  return (
    <Card
      title="How it works"
      action={
        changed ? (
          <Button tone="plain" onClick={() => set({ ...BOX_PAGE_DEFAULTS.howItWorks, steps: [...BOX_PAGE_DEFAULTS.howItWorks.steps] })}>
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        ) : undefined
      }
    >
      <p className="field__hint">A few plain steps on the box’s page. Remove them all to hide the section.</p>
      <TextField
        label="Heading"
        value={how.title}
        maxLength={BOX_PAGE_LIMITS.title}
        placeholder={BOX_PAGE_DEFAULTS.howItWorks.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      <ol className="mbx-steps">
        {steps.map((step, i) => (
          <li key={i} className="mbx-step">
            <span className="mbx-step__no num" aria-hidden="true">
              {i + 1}
            </span>
            <input
              className="input"
              aria-label={`Step ${i + 1}`}
              value={step}
              maxLength={BOX_PAGE_LIMITS.step}
              onChange={(e) => set({ steps: steps.map((s, j) => (j === i ? e.target.value : s)) })}
            />
            <Button tone="plain" iconOnly aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              tone="plain"
              iconOnly
              aria-label={`Move step ${i + 1} down`}
              disabled={i === steps.length - 1}
              onClick={() => move(i, i + 1)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button tone="plain" iconOnly aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: steps.filter((_, j) => j !== i) })}>
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      {steps.length === 0 ? <p className="muted">No steps, so the section is hidden on the shop.</p> : null}
      <div>
        <Button disabled={steps.length >= BOX_PAGE_LIMITS.steps} onClick={() => set({ steps: [...steps, ''] })}>
          <Plus aria-hidden="true" />
          Add a step
        </Button>
      </div>
    </Card>
  );
}

/** A searchable list of products on sale, pick several, add them in one go. */
/** "A", "A and B", "A, B and C". */
function listSentence(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Why a product can't be picked: already on this list (`here`), or on the other one. */
interface Unavailable {
  here: boolean;
  hint: string;
}

function ProductPicker({
  products,
  unavailable,
  title,
  onClose,
  onAdd,
}: {
  products: ShopProduct[];
  unavailable: Map<string, Unavailable>;
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
              const blocked = unavailable.get(p.id);
              const on = blocked !== undefined;
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
                      hint={blocked?.hint}
                      checked={blocked?.here === true || chosen.has(p.id)}
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
