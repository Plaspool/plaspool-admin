import { useCallback, useEffect, useState } from 'react';
import { Bell, Lock, Settings as SettingsIcon } from 'lucide-react';
import { shopApi, type ShopNotificationSettings } from '../../data/api-shop';
import { StaleWriteError } from '../../data/errors';
import { dateTime } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Card } from '../ui/Card';
import { Banner, Button, EmptyState, Loading } from '../ui/primitives';
import { Toggle } from '../ui/Field';
import { SaveBar } from '../ui/SaveBar';
import { TagInput } from '../ui/TagInput';
import { useToast } from '../ui/Toast';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';

/**
 * ORDER NOTIFICATIONS — `/settings/notifications`: who is emailed when an
 * order is paid for.
 *
 * THE OTHER TWO WAYS AN ORDER REACHES SOMEBODY NEED NOTHING FROM THIS SCREEN,
 * and that is worth knowing before adding a switch here for them. The bell in
 * the top bar picks new orders up on its own poll, and the desktop pop-up is a
 * BROWSER permission granted from the bell's own panel — neither is a stored
 * preference, so neither has a row to edit. This screen owns the one channel
 * that survives the admin being closed, which is exactly why it is the one
 * that has to be configurable.
 *
 * THE CAS IS THE PART TO GET RIGHT, and no other v2 screen does this yet. The
 * row carries a `revision`; the save sends back the one it loaded; a lost race
 * comes home as `StaleWriteError`. The answer to that is NOT to retry with the
 * fresh revision — that overwrites somebody's change with a click they did not
 * make and tells nobody. So a refusal loads THEIRS, says so plainly, and hands
 * the decision back.
 */

/** The three editable fields, held apart from the server's row so "dirty" is
 *  a comparison rather than a flag somebody has to remember to set. */
interface Draft {
  notifyOnOrder: boolean;
  notifyTeam: boolean;
  orderRecipients: string[];
}

const draftOf = (row: ShopNotificationSettings): Draft => ({
  notifyOnOrder: row.notifyOnOrder,
  notifyTeam: row.notifyTeam,
  orderRecipients: [...row.orderRecipients],
});

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The wire's own limits (the PATCH body's zod), applied here so the refusal
 *  arrives beside the box rather than as a 400 after the press. */
const MAX_RECIPIENTS = 50;
const MAX_LENGTH = 320;

/**
 * `plausibleAddress` from `server/shop/notifications/repo.ts`, character for
 * character.
 *
 * THE SAME RULE AS THE SERVER'S, NEITHER STRICTER NOR LOOSER, and both halves
 * of that matter. Looser and Save bounces off a 400 the person cannot read.
 * Stricter and this screen refuses an address the shop can genuinely mail —
 * which is the worse of the two, because the only way out of it is to find
 * somebody who can edit the row by hand. The server is the authority; this is
 * a copy of its answer, moved to where the typing happens.
 */
const PLAUSIBLE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export default function SettingsNotifications() {
  const toast = useToast();
  /* The settings domain is owner/developer territory (shared/roles.ts) — the
     same graceful absence Shipping and Team render, rather than a screen of
     controls that all 403. */
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const scoped = viewer !== null && hasDomain(viewer.role, 'settings');

  const [row, setRow] = useState<ShopNotificationSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* Set only by a lost CAS, and cleared by the next edit or the next save:
     the banner it draws is about one refusal, not a standing condition. */
  const [beaten, setBeaten] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await shopApi.getNotificationSettings(signal);
      setRow(next);
      setDraft(draftOf(next));
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
      );
    }
  }, []);

  useEffect(() => {
    if (!scoped) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, scoped]);

  if (!scoped) {
    return (
      <div className="page">
        <PageHeader
          icon={<SettingsIcon />}
          title="Order notifications"
          backTo="/settings"
          backLabel="Settings"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="Only the owner and developers can change this"
            body="This decides who is emailed about real orders, so only the owner and developers can change it."
          />
        </div>
      </div>
    );
  }

  function edit(patch: Partial<Draft>) {
    setBeaten(false);
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  }

  /* Trimmed once, here, and it is the same list that travels: a check against
     one spelling and a save of another is a validation that passes and a
     request that 400s. */
  const typed = (draft?.orderRecipients ?? []).map((value) => value.trim()).filter(Boolean);
  const tooLong = typed.find((value) => value.length > MAX_LENGTH);
  const notAnAddress = typed.find((value) => !PLAUSIBLE.test(value));
  const problem =
    typed.length > MAX_RECIPIENTS
      ? `That is ${typed.length} addresses. ${MAX_RECIPIENTS} is the most this can hold.`
      : tooLong !== undefined
        ? 'One of these addresses is far too long to be real.'
        : notAnAddress !== undefined
          ? `“${notAnAddress}” is not an email address, so nothing would reach it.`
          : null;

  const dirty =
    row !== null &&
    draft !== null &&
    (draft.notifyOnOrder !== row.notifyOnOrder ||
      draft.notifyTeam !== row.notifyTeam ||
      !sameList(typed, row.orderRecipients));

  async function save() {
    if (row === null || draft === null) return;
    setSaving(true);
    try {
      const next = await shopApi.saveNotificationSettings({
        expectedRevision: row.revision,
        notifyOnOrder: draft.notifyOnOrder,
        notifyTeam: draft.notifyTeam,
        orderRecipients: typed,
      });
      setRow(next);
      setDraft(draftOf(next));
      setBeaten(false);
      toast.show('Saved');
    } catch (cause) {
      if (cause instanceof StaleWriteError) {
        /* THEIRS WINS AND THE EDIT IS DISCARDED, deliberately. Re-sending with
           the fresh revision would erase whatever they changed with a click
           this person never made — and there are three fields here, so asking
           somebody to make their change again is cheap. The banner is what
           makes that honest instead of mysterious. */
        setBeaten(true);
        await load();
        return;
      }
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        icon={<Bell />}
        title="Order notifications"
        backTo="/settings"
        backLabel="Settings"
        subtitle="Who gets an email when an order comes in."
      />

      {loadError ? (
        <Banner
          tone="critical"
          title="Couldn’t load notification settings"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {loadError}
        </Banner>
      ) : null}

      {beaten ? (
        <Banner tone="warn" title="Somebody else changed this while you had it open">
          Their version is on screen now. Check it, then make your change again.
        </Banner>
      ) : null}

      {row !== null && !row.notifyOnOrder ? (
        <Banner tone="warn" title="Nobody is emailed when an order comes in">
          Orders still arrive and still show in the bell. Only the email is switched off.
        </Banner>
      ) : null}

      {/* THE SWITCH SAYS ON AND NOTHING IS SENT. An empty address list is a
          legitimate saved state — the team roster is where the addresses come
          from — but the team switched OFF with the list empty leaves the whole
          thing on and delivering to nobody, which is a configuration that
          looks correct on this screen and quietly loses every order email.
          Said against the SAVED row, like the banner above it, so it reports
          what is true rather than what is half-typed. */}
      {row !== null && row.notifyOnOrder && !row.notifyTeam && row.orderRecipients.length === 0 ? (
        <Banner tone="warn" title="This is on, but there is nobody to send to">
          The team is switched off and no other addresses are listed, so no email goes anywhere.
          Switch the team back on, or add an address below.
        </Banner>
      ) : null}

      {draft === null ? (
        loadError ? null : (
          <Card>
            <Loading what="notification settings" />
          </Card>
        )
      ) : (
        <Card title="Email">
          <Toggle
            label="Email us when an order comes in"
            checked={draft.notifyOnOrder}
            onChange={(next) => edit({ notifyOnOrder: next })}
          />
          <span className="field__hint">
            Sent as soon as the money lands, not when the order is first placed.
          </span>

          <Toggle
            label="Everyone on the team who handles orders"
            checked={draft.notifyTeam}
            onChange={(next) => edit({ notifyTeam: next })}
          />
          <span className="field__hint">
            Follows the team list, so somebody who leaves stops getting these on their own.
          </span>

          <TagInput
            label="Other addresses"
            value={draft.orderRecipients}
            onChange={(next) => edit({ orderRecipients: next })}
            hint="A shared inbox or a warehouse address. One per entry."
            placeholder="orders@plaspool.com"
          />
          {problem ? <span className="field__error">{problem}</span> : null}
        </Card>
      )}

      {row !== null ? (
        <p className="page__learn">
          Last changed {dateTime(row.updatedAt)}. An order also shows up in the bell at the top of
          this page, and can pop up on your screen while the admin is open — both of those are set
          up from the bell itself and need nothing here.
        </p>
      ) : null}

      <SaveBar
        when={dirty}
        saving={saving}
        disabled={problem !== null}
        onDiscard={() => {
          setBeaten(false);
          if (row !== null) setDraft(draftOf(row));
        }}
        onSave={() => void save()}
      />
    </div>
  );
}
