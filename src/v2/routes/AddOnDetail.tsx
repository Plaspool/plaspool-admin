import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { moneyRefusalMessage, parseMajor, plainMajor, shopApi, type AddOnStatus, type ShopAddOn } from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { humanise, productTone } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader } from '../ui/Page';
import { Badge, Banner } from '../ui/primitives';
import { Card } from '../ui/Card';
import { AffixField, Segmented, TextArea, TextField } from '../ui/Field';
import { SingleImage } from '../ui/Img';
import { SaveBar } from '../ui/SaveBar';
import { useToast } from '../ui/Toast';
import { AddOnRules, nextUid, type EditableRule } from './AddOnRules';

/**
 * ADD-ON EDITOR — `/products/add-ons/new` and `/products/add-ons/:id`.
 * Left: the thing (picture, name, description, price, status). Right: when to
 * offer it. Saves the whole row under the loaded revision; a 409 stale_write
 * shows a banner rather than a "Saved" it cannot honour.
 */
const STATUSES: { value: AddOnStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

interface Draft {
  title: string;
  description: string;
  imageId: string | null;
  priceText: string;
  status: AddOnStatus;
  position: number;
  rules: EditableRule[];
}

const fresh = (): Draft => ({
  title: '',
  description: '',
  imageId: null,
  priceText: '',
  status: 'draft',
  position: 0,
  rules: [{ uid: nextUid(), when: [], then: 'ask', amountMinor: null }],
});
const fromRow = (a: ShopAddOn): Draft => ({
  title: a.title,
  description: a.description ?? '',
  imageId: a.imageId,
  priceText: plainMajor(a.priceMinor, a.currency),
  status: a.status,
  position: a.position,
  rules: a.rules.map((r) => ({
    ...r,
    uid: nextUid(),
    // A loaded rule with no `amountMinor` key at all, and one blurred back to
    // empty (which writes an explicit `null`), have to compare equal —
    // otherwise opening a saved add-on and tapping straight out of an
    // already-empty Charge box flips the save bar on having changed nothing.
    amountMinor: r.amountMinor ?? null,
    when: r.when.map((c) => ({ ...c, uid: nextUid() })),
  })),
});

/**
 * Fresh client-only ids for every rule and condition in a draft — used on
 * Discard so React remounts every rule card rather than reusing the ones on
 * screen. Reusing them would leave an uncontrolled Charge (or a money
 * From/To/Value field) still showing whatever was typed: `defaultValue` only
 * applies at mount, so a same-keyed element that survives a state reset never
 * re-reads it.
 */
const withUids = (d: Draft): Draft => ({
  ...d,
  rules: d.rules.map((r) => ({
    ...r,
    uid: nextUid(),
    when: r.when.map((c) => ({ ...c, uid: nextUid() })),
  })),
});

/**
 * `draft`/`saved` with every uid stripped — the shape that actually goes over
 * the wire, and the shape `dirty` compares. Without this, two loads of the
 * SAME row (`fromRow` mints a fresh uid every time) would never compare
 * equal, and Discard's freshly-reminted uids would look like a change that
 * never happened.
 */
function plain(d: Draft) {
  return {
    ...d,
    rules: d.rules.map(({ uid, when, ...r }) => ({ ...r, when: when.map(({ uid: _c, ...c }) => c) })),
  };
}

export default function AddOnDetail({ create = false }: { create?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [row, setRow] = useState<ShopAddOn | null>(null);
  const [draft, setDraft] = useState<Draft>(fresh);
  const [saved, setSaved] = useState<Draft>(fresh);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  // The Product condition picks by title (spec: no raw ids typed by hand).
  // One page is enough for the picker, same as the command palette's own
  // product pool (`Palette.tsx`); empty while it loads costs nothing here,
  // since a rule with no product condition never reads this at all.
  const productsAsync = useAsync((signal) => shopApi.listProducts({ limit: 50 }, signal), []);
  const products = (productsAsync.data?.items ?? []).map((p) => ({ id: p.id, title: p.title }));

  useEffect(() => {
    if (create || !id) return;
    const controller = new AbortController();
    shopApi
      .getAddOn(id, controller.signal)
      .then((a) => {
        setRow(a);
        setDraft(fromRow(a));
        setSaved(fromRow(a));
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      });
    return () => controller.abort();
  }, [create, id]);

  // The loaded row's own currency, never a hard-coded one — `fromRow` already
  // formats the price with `a.currency`, and a fresh add-on (no row yet)
  // falls back to the store's single currency until multi-currency ships.
  const currency = row?.currency ?? 'NGN';
  const price = parseMajor(draft.priceText, currency);
  const priceError = draft.priceText.trim() === '' ? 'A price is needed. 0 is fine.' : price.ok ? null : moneyRefusalMessage(price.reason, currency);
  const dirty = JSON.stringify(plain(draft)) !== JSON.stringify(plain(saved));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const body = () => {
    const p = plain(draft);
    return {
      title: p.title.trim(),
      description: p.description.trim() === '' ? null : p.description.trim(),
      imageId: p.imageId,
      priceMinor: price.ok ? price.minor : 0,
      status: p.status,
      position: p.position,
      rules: p.rules,
    };
  };

  async function save() {
    if (saving || priceError || draft.title.trim() === '') return;
    setSaving(true);
    try {
      if (create) {
        const created = await shopApi.createAddOn(body());
        toast.show(`${created.title} created as a draft`);
        navigate(`/products/add-ons/${created.id}`, { replace: true });
        return;
      }
      const next = await shopApi.updateAddOn(row!.id, body(), row!.revision);
      setRow(next);
      setDraft(fromRow(next));
      setSaved(fromRow(next));
      setConflict(false);
      toast.show('Saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else toast.show(cause instanceof Error && cause.message ? cause.message : 'Could not save.', 'critical');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="page">
        <Banner tone="critical" title="Couldn’t load this add-on">{loadError}</Banner>
      </div>
    );
  }
  if (!create && !row) return <div className="page" />;

  return (
    <div className="page">
      <SaveBar
        when={dirty || saving}
        label={create ? 'Unsaved add-on' : 'Unsaved changes'}
        saving={saving}
        disabled={draft.title.trim() === '' || priceError !== null}
        onDiscard={() => (create ? navigate('/products/add-ons') : setDraft(withUids(saved)))}
        onSave={() => void save()}
      />
      <PageHeader
        icon={<Gift />}
        title={create ? 'New add-on' : row!.title}
        titleBadge={create ? null : <Badge tone={productTone(row!.status)}>{humanise(row!.status)}</Badge>}
        backTo="/products/add-ons"
        backLabel="Add-ons"
      />
      {conflict ? (
        <Banner tone="warn" title="Someone else saved this add-on since you opened it">
          Reload to see their version, then make your change again.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          <Card title="The add-on">
            <SingleImage value={draft.imageId} onChange={(imageId) => set('imageId', imageId)} alt={draft.title} />
            <TextField label="Name" value={draft.title} onChange={(e) => set('title', e.currentTarget.value)} error={dirty && draft.title.trim() === '' ? 'An add-on needs a name.' : null} />
            <TextArea label="Description" rows={3} value={draft.description} onChange={(e) => set('description', e.currentTarget.value)} hint="One or two plain sentences. The shopper reads this at checkout." />
            <AffixField label="Price" prefix="₦" inputMode="decimal" value={draft.priceText} onChange={(e) => set('priceText', e.currentTarget.value)} error={dirty ? priceError : null} hint="What it costs when it is added. A rule can charge something else." />
            <Segmented label="Status" value={draft.status} options={STATUSES} onChange={(status) => set('status', status)} hint="Only Active add-ons are offered at checkout." />
          </Card>
        </div>
        <aside className="form2__side">
          <AddOnRules rules={draft.rules} priceMinor={price.ok ? price.minor : 0} currency={currency} products={products} onChange={(rules) => set('rules', rules)} />
        </aside>
      </div>
    </div>
  );
}
