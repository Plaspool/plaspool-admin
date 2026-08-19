import { useCallback, useEffect, useState } from 'react';
import { Truck } from 'lucide-react';
import {
  shopApi,
  type ShopShippingOption,
  type ShopShippingZone,
} from '../data/api-shop';
import { ApiError } from '../data/errors';
import './shop.css';

/**
 * Shipping zones — the admin-editable replacement for the hardcoded
 * `DEFAULT_SHIPPING_ZONES` constant (migration 0240, admin#19).
 *
 * FOLLOWS THE SHAPE `ShopCategories.tsx` ESTABLISHED: a plain list loaded on
 * mount, inline editing of one row at a time, `ApiError` mapped to a field-
 * or-conflict message rather than echoed raw. The entire point of this screen
 * is that an operator can change a delivery rate here without a deploy — see
 * the migration's own header note.
 *
 * A zone's `regions` box is free text, comma-separated, matched case- and
 * whitespace-insensitively by `zoneFor` (`server/shop/cart/checkout/shipping.ts`).
 * Empty means "no region restriction" — the zone matches any address in its
 * countries, which is how the fallback zone is configured.
 */

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      /*
       * Four different refusals share this status, and the server tells them
       * apart with `operation` (`shipping-zones-repo.ts`) precisely so this
       * screen can say the right thing instead of one generic "conflict".
       */
      const body = err.body as { operation?: string } | undefined;
      if (body?.operation === 'delete_fallback') {
        return 'This is the fallback zone — every unmatched address prices from it. Designate another zone as the fallback first, then delete this one.';
      }
      if (body?.operation === 'unset_fallback') {
        return 'This is the fallback zone. Designate another zone as the fallback first — that switches it automatically — rather than turning this one off.';
      }
      return 'Only one zone can be the fallback. Remove the fallback flag from the current one first.';
    }
    if (err.status === 400 && err.detail === 'zone_has_options') {
      return 'This zone still has delivery options. Delete them first.';
    }
    if (err.status === 400 && err.detail) {
      return `That value for “${err.detail}” could not be used.`;
    }
  }
  return fallback;
}

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ZoneDraft {
  label: string;
  countries: string;
  regions: string;
  isFallback: boolean;
}

const zoneDraftOf = (z: ShopShippingZone): ZoneDraft => ({
  label: z.label,
  countries: z.countries.join(', '),
  regions: z.regions.join(', '),
  isFallback: z.isFallback,
});

interface OptionDraft {
  label: string;
  amountMinor: string;
  estimate: string;
}

const optionDraftOf = (o: ShopShippingOption): OptionDraft => ({
  label: o.label,
  amountMinor: String(o.amountMinor),
  estimate: o.estimate,
});

export default function ShopShippingZones() {
  const [zones, setZones] = useState<ShopShippingZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [zoneFields, setZoneFields] = useState<ZoneDraft>({
    label: '',
    countries: '',
    regions: '',
    isFallback: false,
  });

  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [optionFields, setOptionFields] = useState<OptionDraft>({
    label: '',
    amountMinor: '',
    estimate: '',
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setZones(await shopApi.listShippingZones(signal));
      setError(null);
    } catch {
      setError('Could not load shipping zones.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  function startEditZone(zone: ShopShippingZone): void {
    setEditingZoneId(zone.id);
    setZoneFields(zoneDraftOf(zone));
  }

  async function saveZone(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await shopApi.saveShippingZone(id, {
        label: zoneFields.label.trim(),
        countries: parseCsv(zoneFields.countries).map((c) => c.toUpperCase()),
        regions: parseCsv(zoneFields.regions),
        isFallback: zoneFields.isFallback,
      });
      setEditingZoneId(null);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not save this zone.'));
    } finally {
      setBusy(null);
    }
  }

  async function deleteZone(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await shopApi.deleteShippingZone(id);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not delete this zone.'));
    } finally {
      setBusy(null);
    }
  }

  function startEditOption(option: ShopShippingOption): void {
    setEditingOptionId(option.id);
    setOptionFields(optionDraftOf(option));
  }

  async function saveOption(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const amountMinor = Number(optionFields.amountMinor);
      if (!Number.isInteger(amountMinor) || amountMinor < 0) {
        throw new Error('bad amount');
      }
      await shopApi.saveShippingOption(id, {
        label: optionFields.label.trim(),
        amountMinor,
        estimate: optionFields.estimate.trim(),
      });
      setEditingOptionId(null);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not save this option — the rate must be a whole number of minor units (e.g. 300000 for ₦3,000).'));
    } finally {
      setBusy(null);
    }
  }

  async function deleteOption(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await shopApi.deleteShippingOption(id);
      await load();
    } catch (err) {
      setError(messageFor(err, 'Could not delete this option.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="shopcat">
      <header className="shopcat__header">
        <h1 className="shopcat__title">
          <Truck size={20} aria-hidden="true" /> Shipping zones
        </h1>
        <p className="shopcat__intro">
          Delivery rates by destination. Editing a rate here takes effect on the next
          checkout call — no deploy needed.
        </p>
      </header>

      {error && (
        <p className="shopcat__error" role="alert">
          {error}
        </p>
      )}
      {loading && <p>Loading…</p>}

      {!loading &&
        zones.map((zone) => (
          <section className="shopcat__row" key={zone.id}>
            {editingZoneId === zone.id ? (
              <div className="shopcat__form">
                <label>
                  Label
                  <input
                    value={zoneFields.label}
                    onChange={(e) => setZoneFields((f) => ({ ...f, label: e.target.value }))}
                  />
                </label>
                <label>
                  Countries (ISO codes, comma-separated)
                  <input
                    value={zoneFields.countries}
                    onChange={(e) =>
                      setZoneFields((f) => ({ ...f, countries: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Regions (comma-separated, blank = whole country)
                  <input
                    value={zoneFields.regions}
                    onChange={(e) => setZoneFields((f) => ({ ...f, regions: e.target.value }))}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={zoneFields.isFallback}
                    onChange={(e) =>
                      setZoneFields((f) => ({ ...f, isFallback: e.target.checked }))
                    }
                  />
                  Fallback zone (used when no other zone matches — exactly one allowed)
                </label>
                <div className="shopcat__actions">
                  <button
                    type="button"
                    disabled={busy === zone.id}
                    onClick={() => void saveZone(zone.id)}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingZoneId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="shopcat__summary">
                <strong>{zone.label}</strong>
                {zone.isFallback && <span> (fallback)</span>}
                <div>Countries: {zone.countries.join(', ') || '—'}</div>
                <div>Regions: {zone.regions.join(', ') || 'any'}</div>
                <div className="shopcat__actions">
                  <button type="button" onClick={() => startEditZone(zone)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy === zone.id}
                    onClick={() => void deleteZone(zone.id)}
                  >
                    Delete zone
                  </button>
                </div>
              </div>
            )}

            <ul className="shopcat__options">
              {zone.options.map((option) => (
                <li key={option.id}>
                  {editingOptionId === option.id ? (
                    <div className="shopcat__form">
                      <label>
                        Label
                        <input
                          value={optionFields.label}
                          onChange={(e) =>
                            setOptionFields((f) => ({ ...f, label: e.target.value }))
                          }
                        />
                      </label>
                      <label>
                        Rate (minor units, e.g. 300000 = ₦3,000)
                        <input
                          value={optionFields.amountMinor}
                          onChange={(e) =>
                            setOptionFields((f) => ({ ...f, amountMinor: e.target.value }))
                          }
                        />
                      </label>
                      <label>
                        Delivery estimate
                        <input
                          value={optionFields.estimate}
                          onChange={(e) =>
                            setOptionFields((f) => ({ ...f, estimate: e.target.value }))
                          }
                        />
                      </label>
                      <div className="shopcat__actions">
                        <button
                          type="button"
                          disabled={busy === option.id}
                          onClick={() => void saveOption(option.id)}
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingOptionId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span>
                        {option.label} — {option.amountMinor} minor units
                        {option.estimate ? ` (${option.estimate})` : ''}
                      </span>
                      <button type="button" onClick={() => startEditOption(option)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy === option.id}
                        onClick={() => void deleteOption(option.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
