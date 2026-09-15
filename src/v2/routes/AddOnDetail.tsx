import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Archive, ArchiveRestore, Gift, ImagePlus } from 'lucide-react';
import { moneyRefusalMessage, parseMajor, plainMajor, shopApi, type AddOnStatus, type ShopAddOn } from '../../data/api-shop';
import { ApiError } from '../../data/errors';
import { ImageError, storeImageFile } from '../../data/images';
import { humanise, productTone } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button } from '../ui/primitives';
import { Card } from '../ui/Card';
import { MoneyField, Toggle } from '../ui/Field';
import { StoredImg } from '../ui/Img';
import { MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { SaveBar } from '../ui/SaveBar';
import { useToast } from '../ui/Toast';
import { AddOnRules, nextUid, type EditableRule } from './AddOnRules';

/**
 * ADD-ON EDITOR — `/products/add-ons/new` and `/products/add-ons/:id`.
 *
 * Laid out like the reference admin's collection page (the owner's
 * screenshots, 2026-09-06): the picture tile beside a heading-style name and
 * a plain description, the rule builder underneath in the wide column, and
 * the one switch that matters — offered at checkout or not — in the sidebar.
 * Archiving is a "More actions" item behind a confirmation, not a third
 * position on a status control.
 *
 * Saves the whole row under the loaded revision; a 409 stale_write shows a
 * banner rather than a "Saved" it cannot honour.
 */

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
 * Discard so React remounts every rule block rather than reusing the ones on
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
 *
 * The price box's grouping commas go too: `MoneyField` writes `1,500.00` into
 * the draft while the saved copy holds `1500.00`, and the same amount must
 * not light the save bar. `body()` sends the parsed minor units, never this.
 */
function plain(d: Draft) {
  return {
    ...d,
    priceText: d.priceText.replace(/,/g, ''),
    rules: d.rules.map(({ uid, when, ...r }) => ({ ...r, when: when.map(({ uid: _c, ...c }) => c) })),
  };
}

/**
 * The picture tile: a dashed square that opens the file dialog, the picture
 * itself once one is set. Uploads through `storeImageFile` — validate, strip
 * EXIF, upload, commit — and nothing lands in the draft until the server has
 * committed the object, the same rule the product media card keeps.
 */
function PictureTile({
  value,
  alt,
  onChange,
}: {
  value: string | null;
  alt: string;
  onChange: (next: string | null) => void;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const stored = await storeImageFile(file);
      onChange(stored.id);
    } catch (err) {
      toast.show(err instanceof ImageError ? err.message : 'That image could not be added.', 'critical');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)', alignItems: 'center' }}>
      <button
        type="button"
        className={value ? 'addon-hero__pic addon-hero__pic--set' : 'addon-hero__pic'}
        aria-label={value ? 'Replace picture' : 'Add picture'}
        disabled={uploading}
        onClick={() => fileInput.current?.click()}
      >
        {value ? <StoredImg id={value} alt={alt} /> : <ImagePlus aria-hidden="true" />}
      </button>
      {value ? (
        <button type="button" className="addon-hero__picrow" style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => onChange(null)}>
          Remove picture
        </button>
      ) : (
        <span className="addon-hero__picrow">{uploading ? 'Uploading…' : 'Picture'}</span>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="sr"
        aria-label="Picture file"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
    </div>
  );
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
  const [confirmArchive, setConfirmArchive] = useState(false);

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
        // Our own abort (unmount, or StrictMode's first mount) surfaces from
        // the data layer as a "could not reach the server" ApiError, not as a
        // bare AbortError — so the signal, not the error's shape, is the test.
        if (controller.signal.aborted) return;
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
  const archived = draft.status === 'archived';

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

  /** Apply a saved row to every copy of it this screen holds. */
  function adopt(next: ShopAddOn) {
    setRow(next);
    setDraft(fromRow(next));
    setSaved(fromRow(next));
    setConflict(false);
  }

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
      adopt(await shopApi.updateAddOn(row!.id, body(), row!.revision));
      toast.show('Saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else toast.show(cause instanceof Error && cause.message ? cause.message : 'Could not save.', 'critical');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Archive, or put back, IMMEDIATELY — a "More actions" item, not a field
   * waiting on Save. Only the status moves: the row's other columns are left
   * exactly as stored, so an unsaved edit on screen is neither lost nor
   * silently shipped along with it.
   */
  async function setStatus(status: AddOnStatus) {
    if (saving || !row) return;
    setSaving(true);
    try {
      const next = await shopApi.updateAddOn(row.id, { status }, row.revision);
      adopt(next);
      toast.show(status === 'archived' ? `${next.title} archived` : `${next.title} put back as a draft`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else toast.show(cause instanceof Error && cause.message ? cause.message : 'Could not change the status.', 'critical');
    } finally {
      setSaving(false);
      setConfirmArchive(false);
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
        menu={
          create
            ? undefined
            : (close) =>
                row!.status === 'archived' ? (
                  <MenuItem
                    icon={<ArchiveRestore aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      void setStatus('draft');
                    }}
                  >
                    Put it back
                  </MenuItem>
                ) : (
                  <MenuItem
                    critical
                    icon={<Archive aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmArchive(true);
                    }}
                  >
                    Archive add-on
                  </MenuItem>
                )
        }
      />
      {conflict ? (
        <Banner tone="warn" title="Someone else saved this add-on since you opened it">
          Reload to see their version, then make your change again.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          <Card>
            <div className="addon-hero">
              <PictureTile value={draft.imageId} alt={draft.title} onChange={(imageId) => set('imageId', imageId)} />
              <div className="addon-hero__body">
                <input
                  className="addon-hero__title"
                  aria-label="Name"
                  placeholder="Add-on name"
                  value={draft.title}
                  onChange={(e) => set('title', e.currentTarget.value)}
                />
                {dirty && draft.title.trim() === '' ? <span className="addon-hero__error">An add-on needs a name.</span> : null}
                <textarea
                  className="addon-hero__desc"
                  aria-label="Description"
                  placeholder="Add description — one or two plain sentences the shopper reads at checkout"
                  rows={3}
                  value={draft.description}
                  onChange={(e) => set('description', e.currentTarget.value)}
                />
              </div>
            </div>
            <div className="addon-price">
              <MoneyField
                label="Price"
                currency={currency}
                value={draft.priceText}
                onChange={(e) => set('priceText', e.currentTarget.value)}
                error={dirty ? priceError : null}
                hint="What one costs. A rule can set a different amount, charge it for each item, or hand it back."
              />
            </div>
          </Card>
          <AddOnRules rules={draft.rules} priceMinor={price.ok ? price.minor : 0} currency={currency} products={products} onChange={(rules) => set('rules', rules)} />
        </div>
        <aside className="form2__side">
          <Card title="Status">
            {archived ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                Archived — not offered at checkout. Put it back from <strong>More actions</strong> to
                switch it on again.
              </p>
            ) : (
              <>
                <Toggle
                  label="Offered at checkout"
                  checked={draft.status === 'active'}
                  onChange={(on) => set('status', on ? 'active' : 'draft')}
                />
                <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5, marginTop: 'var(--s2)' }}>
                  Switched on, shoppers see it at checkout. Switched off, it stays a draft. Takes effect
                  when you save.
                </p>
              </>
            )}
          </Card>
        </aside>
      </div>

      {confirmArchive && row ? (
        <Modal
          title={`Archive ${row.title}?`}
          onClose={() => setConfirmArchive(false)}
          footer={
            <>
              <Button onClick={() => setConfirmArchive(false)}>Cancel</Button>
              <Button tone="critical" busy={saving} onClick={() => void setStatus('archived')}>
                Archive
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            It stops being offered at checkout. Orders that already carry it keep it, and you can put
            it back from More actions later.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
