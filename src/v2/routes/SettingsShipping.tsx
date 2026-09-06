import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Info, Lock, MoreHorizontal, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import {
  moneyRefusalMessage,
  parseMajor,
  plainMajor,
  shopApi,
  type ShopShippingOption,
  type ShopShippingZone,
} from '../../data/api-shop';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { AffixField, Checkbox, TextField } from '../ui/Field';
import { Float } from '../ui/Float';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { TagInput } from '../ui/TagInput';
import { useToast } from '../ui/Toast';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';

/**
 * SHIPPING — `/settings/shipping`: shipping zones and their delivery options,
 * the half of settings that prices real orders today. Moved whole from the old
 * one-page `/settings` when Settings became a section (index + subroutes);
 * nothing about the zones behaviour changed in the move.
 *
 * THE FALLBACK RULE IS THE SERVER'S AND THE UI RESPECTS IT BY ABSENCE:
 * exactly one fallback zone must exist, and deleting or demoting the last
 * one is refused — so the fallback's row offers no Delete, and its edit
 * modal pins the fallback flag rather than letting the press bounce off a
 * 409.
 */

const STORE_CURRENCY = 'NGN';

export default function SettingsShipping() {
  const toast = useToast();
  /* The settings domain is owner/developer territory (shared/roles.ts) — the
     same graceful absence the Team screen renders, instead of a screen of
     controls that all 403. */
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'settings');
  const [zones, setZones] = useState<ShopShippingZone[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'closed' | 'new' | ShopShippingZone>('closed');
  const [optionsFor, setOptionsFor] = useState<ShopShippingZone | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ShopShippingZone | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setZones(await shopApi.listShippingZones(signal));
      setLoadError(null);
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

  /* Keep a modal's zone in step with a fresh list, so option edits show
     through without closing anything. */
  useEffect(() => {
    if (!optionsFor || !zones) return;
    const fresh = zones.find((z) => z.id === optionsFor.id);
    if (fresh && fresh !== optionsFor) setOptionsFor(fresh);
  }, [zones, optionsFor]);

  const allZeroTax = (zones ?? []).length > 0 && (zones ?? []).every((z) => z.taxRateBps === 0);
  const fallbackCount = (zones ?? []).filter((z) => z.isFallback).length;

  if (!scoped) {
    return (
      <div className="page">
        <PageHeader
          icon={<SettingsIcon />}
          title="Shipping"
          backTo="/settings"
          backLabel="Settings"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="Only the owner and developers can change this"
            body="Delivery prices affect what real customers are charged, so only the owner and developers can change them."
          />
        </div>
      </div>
    );
  }

  async function deleteZone(zone: ShopShippingZone) {
    try {
      await shopApi.deleteShippingZone(zone.id);
      toast.show(`${zone.label} deleted`);
      setConfirmDelete(null);
      void load();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      setConfirmDelete(null);
    }
  }

  const columns: Column<ShopShippingZone>[] = [
    {
      key: 'zone',
      header: 'Zone',
      primary: true,
      render: (z) => (
        <IdCell
          thumb={<Globe aria-hidden="true" />}
          title={z.label}
          meta={<ZoneStates zone={z} />}
        />
      ),
    },
    {
      key: 'fallback',
      header: 'Role',
      label: 'Role',
      tight: true,
      render: (z) =>
        z.isFallback ? <Badge tone="info">Catch-all</Badge> : <Badge>Named regions</Badge>,
    },
    {
      key: 'tax',
      header: 'Tax',
      label: 'Tax',
      numeric: true,
      render: (z) => (
        <span className="num">
          {(z.taxRateBps / 100).toFixed(z.taxRateBps % 100 === 0 ? 0 : 2)}%
          {z.taxLabel ? <span className="muted"> {z.taxLabel}</span> : null}
        </span>
      ),
    },
    {
      key: 'options',
      header: 'Delivery options',
      label: 'Delivery options',
      render: (z) => {
        if (z.options.length === 0) return <Badge tone="warn">No options — unshippable</Badge>;
        const cheapest = z.options.reduce((a, b) => (a.amountMinor <= b.amountMinor ? a : b));
        return (
          <span className="muted">
            {z.options.length} · from {money(cheapest.amountMinor, STORE_CURRENCY)}
          </span>
        );
      },
    },
    {
      key: 'act', pin: true,
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (z) => (
        <Menu
          chrome="bare"
          buttonLabel={`Actions for ${z.label}`}
          label={
            <span className="btn btn--plain btn--icon" style={{ display: 'inline-grid', placeItems: 'center' }}>
              <MoreHorizontal aria-hidden="true" />
            </span>
          }
        >
          {(close) => (
            <>
              <MenuItem
                onSelect={() => {
                  close();
                  setEditing(z);
                }}
              >
                Edit zone…
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  close();
                  setOptionsFor(z);
                }}
              >
                Delivery options…
              </MenuItem>
              {/* The last fallback cannot be deleted — the server refuses, so
                  the control is absent rather than a 409. */}
              {z.isFallback && fallbackCount <= 1 ? null : (
                <>
                  <MenuSeparator />
                  <MenuItem
                    critical
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      setConfirmDelete(z);
                    }}
                  >
                    Delete zone…
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<SettingsIcon />}
        title="Shipping"
        backTo="/settings"
        backLabel="Settings"
        subtitle="What each part of the country pays for delivery."
        actions={
          <Button tone="primary" size="lg" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            New zone
          </Button>
        }
      />

      {allZeroTax ? (
        <Banner tone="warn" title="Every zone charges 0% tax">
          This is on purpose until VAT registration is confirmed. Charging tax without being
          registered, and not charging it once you are, are both problems. You can set a rate per
          zone as soon as it is settled.
        </Banner>
      ) : null}

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load zones" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Shipping zones"
        columns={columns}
        rows={zones ?? []}
        rowKey={(z) => z.id}
        onRowClick={(z) => setOptionsFor(z)}
        loading={zones === null && !loadError}
        empty={
          <EmptyState
            icon={<Globe />}
            title="No shipping zones"
            body="Checkout can’t work out delivery costs until you add at least the catch-all zone."
          />
        }
        footer={null}
      />

      <p className="page__learn">
        An order is matched on the state in its delivery address. You need exactly
        one catch-all zone, which covers anywhere the other zones don't name.
      </p>

      {editing !== 'closed' ? (
        <ZoneModal
          zone={editing === 'new' ? null : editing}
          onlyFallback={editing !== 'new' && editing.isFallback && fallbackCount <= 1}
          position={(zones ?? []).length}
          onClose={() => setEditing('closed')}
          onDone={(zone, created) => {
            setEditing('closed');
            void load();
            if (created) setOptionsFor(zone);
          }}
        />
      ) : null}

      {optionsFor ? (
        <OptionsModal zone={optionsFor} onClose={() => setOptionsFor(null)} onChanged={() => void load()} />
      ) : null}

      {confirmDelete ? (
        <Modal
          title={`Delete ${confirmDelete.label}?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button tone="critical" onClick={() => void deleteZone(confirmDelete)}>
                Delete zone
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            Its regions will use the catch-all zone's prices instead. Orders already placed keep
            the price they were given — nothing already sold changes.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ ZONE STATES ══ */

/** How many of a zone's states the row names. The rest sit behind "+N". */
const NAMED_STATES = 3;

/**
 * A zone's states in the row: the first three by name, then "+N" for the
 * rest. Rest of Nigeria names 35 states, and joined on one line they made
 * the zone column wider than the screen — the row scrolled off past its own
 * ⋯ menu (the owner's screenshot, 2026-09-06).
 *
 * The "+N" is a real, always-visible button, not a hover reveal: a touch
 * screen has no hover (CLAUDE.md §5). It opens on hover for a mouse, on focus
 * for a keyboard, and a click PINS it — so a tap works, and so a mouse user
 * can cross into the panel to read it. A hover-opened panel closes once the
 * pointer has left both the button and the panel. It rides `Float` like every
 * other popover: inside `.tscroll` an absolute panel would be clipped.
 */
function ZoneStates({ zone }: { zone: ShopShippingZone }) {
  const named = zone.regions.slice(0, NAMED_STATES);
  const rest = zone.regions.slice(NAMED_STATES);
  const trigger = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed');
  const leaving = useRef<number | null>(null);

  const cancelLeave = useCallback(() => {
    if (leaving.current === null) return;
    window.clearTimeout(leaving.current);
    leaving.current = null;
  }, []);
  /* A short grace, so the pointer can cross the gap into the panel. Only a
     hover-opened panel closes this way; a pinned one waits for a click
     outside, Escape or a scroll (Float's own dismissals). */
  const scheduleLeave = useCallback(() => {
    cancelLeave();
    leaving.current = window.setTimeout(() => {
      leaving.current = null;
      setMode((was) => (was === 'hover' ? 'closed' : was));
    }, 200);
  }, [cancelLeave]);
  useEffect(() => cancelLeave, [cancelLeave]);

  if (zone.regions.length === 0) return <>Anywhere not covered by another zone</>;
  if (rest.length === 0) return <>{named.join(', ')}</>;

  const open = mode !== 'closed';
  const noun = rest.length === 1 ? 'state' : 'states';
  return (
    <span className="zstates">
      <span>{named.join(', ')}</span>
      <button
        ref={trigger}
        type="button"
        className="zstates__more"
        aria-label={`Show the other ${rest.length} ${noun}`}
        aria-expanded={open}
        onMouseEnter={() => {
          cancelLeave();
          setMode((was) => (was === 'closed' ? 'hover' : was));
        }}
        onMouseLeave={scheduleLeave}
        onFocus={() => setMode((was) => (was === 'closed' ? 'hover' : was))}
        onBlur={() => setMode((was) => (was === 'hover' ? 'closed' : was))}
        onClick={(event) => {
          /* The row opens its delivery options on click; this click is ours. */
          event.stopPropagation();
          cancelLeave();
          setMode((was) => (was === 'pinned' ? 'closed' : 'pinned'));
        }}
      >
        +{rest.length}
        <Info aria-hidden="true" />
      </button>
      <Float
        open={open}
        anchor={trigger}
        align="left"
        className="zstates__panel"
        role="tooltip"
        onClose={(opts) => {
          setMode('closed');
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
        <div onMouseEnter={cancelLeave} onMouseLeave={scheduleLeave}>
          <p className="zstates__panel-title">
            {rest.length} more {noun} in {zone.label}
          </p>
          <p className="zstates__panel-list">{rest.join(', ')}</p>
        </div>
      </Float>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════ ZONE MODAL ══ */

function ZoneModal({
  zone,
  onlyFallback,
  position,
  onClose,
  onDone,
}: {
  zone: ShopShippingZone | null;
  /** True when this IS the only fallback — the flag is pinned on. */
  onlyFallback: boolean;
  position: number;
  onClose: () => void;
  onDone: (zone: ShopShippingZone, created: boolean) => void;
}) {
  const toast = useToast();
  const creating = zone === null;
  const [label, setLabel] = useState(zone?.label ?? '');
  const [regions, setRegions] = useState<string[]>(zone?.regions ?? []);
  const [taxPercent, setTaxPercent] = useState(
    zone ? String(zone.taxRateBps / 100) : '0',
  );
  const [taxLabel, setTaxLabel] = useState(zone?.taxLabel ?? '');
  const [shippingTaxable, setShippingTaxable] = useState(zone?.shippingTaxable ?? false);
  const [isFallback, setIsFallback] = useState(zone?.isFallback ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (!label.trim()) {
      setError('Give the zone a name.');
      return;
    }
    const pct = Number(taxPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('Tax must be a percentage between 0 and 100.');
      return;
    }
    const taxRateBps = Math.round(pct * 100);
    if (!isFallback && regions.length === 0) {
      setError('Name at least one region, or make this the catch-all zone.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const created = await shopApi.createShippingZone({
          label: label.trim(),
          countries: ['NG'],
          regions: isFallback ? [] : regions,
          taxRateBps,
          taxLabel: taxLabel.trim(),
          shippingTaxable,
          isFallback,
          position,
        });
        toast.show(`${created.label} created — add its delivery options`);
        onDone(created, true);
      } else {
        const saved = await shopApi.saveShippingZone(zone.id, {
          label: label.trim(),
          regions: isFallback ? [] : regions,
          taxRateBps,
          taxLabel: taxLabel.trim(),
          shippingTaxable,
          isFallback: onlyFallback ? true : isFallback,
        });
        toast.show(`${saved.label} saved`);
        onDone(saved, false);
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'New zone' : `Edit ${zone.label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Create zone' : 'Save zone'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Name" value={label} placeholder="Abuja" autoFocus onChange={(e) => setLabel(e.target.value)} />
        <Checkbox
          label="Catch-all zone"
          hint={
            onlyFallback
              ? 'This is your only catch-all zone. Every store needs exactly one, so it can’t be turned off.'
              : 'Covers anywhere the other zones don’t. You need exactly one of these.'
          }
          checked={onlyFallback ? true : isFallback}
          onChange={(next) => {
            if (!onlyFallback) setIsFallback(next);
          }}
        />
        {isFallback ? null : (
          <TagInput
            label="Regions"
            value={regions}
            onChange={setRegions}
            placeholder="Abuja, Lagos…"
            hint="Orders are matched on the state in the delivery address, so the spelling has to match exactly."
          />
        )}
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 0.7 }}>
            <AffixField
              label="Tax rate"
              suffix="%"
              inputMode="decimal"
              value={taxPercent}
              onChange={(e) => {
                setTaxPercent(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 1.3 }}>
            <TextField label="Tax label" value={taxLabel} placeholder="VAT" onChange={(e) => setTaxLabel(e.target.value)} />
          </div>
        </div>
        <Checkbox label="Tax applies to delivery too" checked={shippingTaxable} onChange={setShippingTaxable} />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

/* ════════════════════════════════════════════════════════ OPTIONS MODAL ══ */

function OptionsModal({
  zone,
  onClose,
  onChanged,
}: {
  zone: ShopShippingZone;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Modal title={`${zone.label} — delivery options`} onClose={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
          What a customer in this zone can choose at checkout. Each row saves on its own, and orders already
          placed keep the price they were given.
        </p>
        {zone.options.length === 0 ? (
          <Banner tone="warn" title="No options — this zone can’t ship">
            Customers here have nothing to choose at checkout until you add an option.
          </Banner>
        ) : (
          zone.options
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((option) => (
              <OptionRow key={option.id} option={option} onChanged={onChanged} />
            ))
        )}
        <NewOptionRow zone={zone} onChanged={onChanged} />
      </div>
    </Modal>
  );
}

function OptionRow({ option, onChanged }: { option: ShopShippingOption; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(option.label);
  const [amount, setAmount] = useState(plainMajor(option.amountMinor, STORE_CURRENCY));
  const [estimate, setEstimate] = useState(option.estimate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = parseMajor(amount, STORE_CURRENCY);
    if (!parsed.ok) {
      setError(moneyRefusalMessage(parsed.reason, STORE_CURRENCY));
      return;
    }
    if (!label.trim()) {
      setError('Give the option a name. Customers see it at checkout.');
      return;
    }
    setBusy(true);
    try {
      await shopApi.saveShippingOption(option.id, {
        label: label.trim(),
        amountMinor: parsed.minor,
        estimate: estimate.trim(),
      });
      toast.show(`${label.trim()} saved`);
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await shopApi.deleteShippingOption(option.id);
      toast.show(`${option.label} removed`);
      onChanged();
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="row" style={{ gap: 'var(--s3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--t-md)', fontWeight: 'var(--w-medium)' }}>{option.label}</div>
          <div className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            {money(option.amountMinor, STORE_CURRENCY)}
            {option.estimate ? ` · ${option.estimate}` : ''}
          </div>
        </div>
        <Button onClick={() => setEditing(true)}>Edit</Button>
        <Button tone="plain" busy={busy} aria-label={`Remove ${option.label}`} onClick={() => void remove()}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="stack stack--tight" style={{ padding: 'var(--s3)', background: 'var(--surface-sunken)', borderRadius: 'var(--r-md)' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s2)' }}>
        <div style={{ flex: 1.2 }}>
          <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div style={{ flex: 0.8 }}>
          <AffixField
            label="Price"
            prefix={STORE_CURRENCY}
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Estimate" value={estimate} placeholder="1–2 days" onChange={(e) => setEstimate(e.target.value)} />
        </div>
      </div>
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button tone="primary" busy={busy} onClick={() => void save()}>
          Save option
        </Button>
      </div>
    </div>
  );
}

function NewOptionRow({ zone, onChanged }: { zone: ShopShippingZone; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(zone.options.length === 0);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [estimate, setEstimate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    const parsed = parseMajor(amount, STORE_CURRENCY);
    if (!label.trim()) {
      setError('The option needs a name.');
      return;
    }
    if (!parsed.ok) {
      setError(moneyRefusalMessage(parsed.reason, STORE_CURRENCY));
      return;
    }
    setBusy(true);
    try {
      await shopApi.createShippingOption({
        zoneId: zone.id,
        label: label.trim(),
        amountMinor: parsed.minor,
        estimate: estimate.trim() || undefined,
        position: zone.options.length,
      });
      toast.show(`${label.trim()} added`);
      setLabel('');
      setAmount('');
      setEstimate('');
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          Add option
        </Button>
      </div>
    );
  }

  return (
    <div className="stack stack--tight" style={{ padding: 'var(--s3)', background: 'var(--surface-sunken)', borderRadius: 'var(--r-md)' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s2)' }}>
        <div style={{ flex: 1.2 }}>
          <TextField label="Name" value={label} placeholder="Standard delivery" autoFocus onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div style={{ flex: 0.8 }}>
          <AffixField
            label="Price"
            prefix={STORE_CURRENCY}
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Estimate" value={estimate} placeholder="1–2 days" onChange={(e) => setEstimate(e.target.value)} />
        </div>
      </div>
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button tone="primary" busy={busy} onClick={() => void add()}>
          Add option
        </Button>
      </div>
    </div>
  );
}
