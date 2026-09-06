import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { moneyRefusalMessage, parseMajor, plainMajor, shopApi, type AddOnRule, type AddOnStatus, type ShopAddOn } from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { humanise, productTone } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner } from '../ui/primitives';
import { Card } from '../ui/Card';
import { AffixField, Segmented, TextArea, TextField } from '../ui/Field';
import { SingleImage } from '../ui/Img';
import { SaveBar } from '../ui/SaveBar';
import { useToast } from '../ui/Toast';
import { AddOnRules } from './AddOnRules';

/**
 * ADD-ON EDITOR — `/products/add-ons/new` and `/products/add-ons/:id`.
 * Left: the thing (picture, name, description, price, status). Right: when to
 * offer it. Saves the whole row under the loaded revision; a 409 stale_write
 * shows a banner rather than a "Saved" it cannot honour.
 */
const CURRENCY = 'NGN';
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
  rules: AddOnRule[];
}

const fresh = (): Draft => ({ title: '', description: '', imageId: null, priceText: '', status: 'draft', position: 0, rules: [{ when: [], then: 'ask' }] });
const fromRow = (a: ShopAddOn): Draft => ({
  title: a.title,
  description: a.description ?? '',
  imageId: a.imageId,
  priceText: plainMajor(a.priceMinor, a.currency),
  status: a.status,
  position: a.position,
  rules: a.rules,
});

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

  const price = parseMajor(draft.priceText, CURRENCY);
  const priceError = draft.priceText.trim() === '' ? 'A price is needed. 0 is fine.' : price.ok ? null : moneyRefusalMessage(price.reason, CURRENCY);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const body = () => ({
    title: draft.title.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    imageId: draft.imageId,
    priceMinor: price.ok ? price.minor : 0,
    status: draft.status,
    position: draft.position,
    rules: draft.rules,
  });

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
        onDiscard={() => (create ? navigate('/products/add-ons') : setDraft(saved))}
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
          <AddOnRules rules={draft.rules} priceMinor={price.ok ? price.minor : 0} currency={CURRENCY} onChange={(rules) => set('rules', rules)} />
        </aside>
      </div>
    </div>
  );
}
