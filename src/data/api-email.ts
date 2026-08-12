/**
 * The email marketing surface's half of HANDOFF §2 A6 — templates, subscribers,
 * broadcasts.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the reason
 * `api-categories.ts` gives at the top of its own file: `api.ts` is being
 * appended to by four writers at once and a file four writers append to is a
 * file that loses a block. This is not a second convention — `apiFetch` below is
 * `api.ts`'s own request function, so `credentials: 'include'`, the error
 * envelope and the §8 status table are the shared ones, unchanged.
 *
 * WRITTEN AGAINST A BACKEND THAT DOES NOT EXIST YET, deliberately (HANDOFF
 * §3 B5). Every path, body and response shape below is copied from §2 A6 rather
 * than from a route file, because there is no route file to copy from; the
 * three places this file guesses beyond what §2 A6 lists are each marked
 * CONTRACT ADDITION with the reason the screen cannot be built without it.
 *
 * Everything here is owner-only on the server (§2 A6) except the public
 * unsubscribe pair, which this module does not touch at all: that one is opened
 * from a mail client by someone who may have no account here, so it belongs to
 * the recipient's browser and not to the admin app.
 */
import { apiFetch, type Page } from './api';

const seg = (value: string): string => encodeURIComponent(value);

// ----------------------------------------------------------------- templates

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  /** Author-supplied HTML. NEVER rendered into this app's DOM — see the iframe
      in `EmailTemplates.tsx` for the whole of why. */
  html: string;
  /** The plain-text alternative. Not optional: a broadcast sends both parts. */
  text: string;
  updatedAt: number;
  updatedBy: string;
}

/** What a create/update sends. Every field, because a partial template cannot
    be rendered and the server's Zod is strict either way. */
export interface TemplateDraft {
  name: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The two variables the server substitutes, in the order they are offered.
 *
 * `{{name}}` is a courtesy. `{{unsubscribe_url}}` is the one that decides
 * whether a broadcast may be sent at all, and it is checked in BOTH bodies
 * because both are delivered — an unsubscribe link present only in the HTML
 * part does not exist for a reader whose client shows the text part.
 */
export const NAME_VAR = '{{name}}';
export const UNSUBSCRIBE_VAR = '{{unsubscribe_url}}';
export const EMAIL_VARIABLES = [NAME_VAR, UNSUBSCRIBE_VAR] as const;

/**
 * The client's copy of the server's activation rule (§2 A6: "require the latter
 * present in html+text to activate a broadcast").
 *
 * DUPLICATED ON PURPOSE, and it must stay identical. The server refuses the
 * send; this exists so the refusal is visible while the template is being
 * written rather than at the moment someone reaches for a button that then
 * 409s. If the two ever disagree the server wins — this one only decides what
 * the screen says.
 */
export function missingUnsubscribe(body: { html: string; text: string }): boolean {
  return !body.html.includes(UNSUBSCRIBE_VAR) || !body.text.includes(UNSUBSCRIBE_VAR);
}

// --------------------------------------------------------------- subscribers

export type SubscriberSource = 'customer' | 'manual' | 'import';

export interface EmailSubscriber {
  id: string;
  email: string;
  source: SubscriberSource;
  /** When they agreed to be emailed. Null for rows carried over without one. */
  consentAt: number | null;
  /**
   * SET ONCE AND THE ROW STAYS. Suppression is not deletion: the address has to
   * remain visible so that re-importing the same file cannot quietly resurrect
   * someone who asked to leave.
   */
  unsubscribedAt: number | null;
}

export type SubscriberFilter = 'subscribed' | 'unsubscribed' | 'all';

/**
 * CONTRACT ADDITION (not in §2 A6's route list).
 *
 * The confirm dialog in front of a broadcast has to state the REAL recipient
 * count, and a keyset page of subscribers cannot produce one — `items.length`
 * is the page size, which is the single most dangerous number this surface
 * could put in front of someone about to email a few thousand people. Two
 * counted aggregates over one indexed column is the cheapest honest answer.
 */
export interface Audience {
  /** Would receive the next broadcast: `unsubscribed_at IS NULL`. */
  subscribed: number;
  /** Would be skipped by it. Shown so the totals visibly account for everyone. */
  suppressed: number;
}

/**
 * CONTRACT ADDITION: the import body.
 *
 * §2 A6 says "import CSV (validate-all-then-write like `/api/import`)" without
 * naming a shape. The CSV never reaches the server: the client parses it,
 * because the writer has to SEE which rows are wrong before anything is
 * written, and a server that rejects the file whole gives them a count instead
 * of a list. `consent` is the assertion the importer makes on the record — it
 * is what `email_subscribers.consentAt` is filled from, and there is nowhere
 * else for that fact to come from on an imported row.
 */
export interface SubscriberImport {
  emails: string[];
  consent: true;
}

export interface SubscriberImportResult {
  added: number;
  /** Already present, in either state. Not an error and not a silent overwrite. */
  skipped: number;
}

// ---------------------------------------------------------------- broadcasts

export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/**
 * One `email_broadcasts` row.
 *
 * `subject`/`html`/`text` are SNAPSHOTS taken when the broadcast was created,
 * not a join to the template: editing a template must not rewrite what was
 * already put in someone's inbox, and the template may be deleted afterwards.
 * That is why the progress view reads its subject from here and never from the
 * template list.
 */
export interface EmailBroadcast {
  id: string;
  templateId: string;
  subject: string;
  html: string;
  text: string;
  status: BroadcastStatus;
  createdBy: string;
  /** CONTRACT ADDITION — every other table in this app has one and the list
      has to be sorted by something a draft also possesses. */
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  sentCount: number;
  failedCount: number;
  /**
   * CONTRACT ADDITION: `COUNT(*)` over `email_broadcast_recipients`.
   *
   * The progress view needs a denominator. Without it "412 sent" is a number
   * with no scale — it could be nearly done or barely started, and those are
   * not the same thing to somebody watching a send they cannot recall.
   */
  recipientCount: number;
}

export const emailApi = {
  // ------------------------------------------------------------- templates
  async listTemplates(signal?: AbortSignal): Promise<EmailTemplate[]> {
    /*
     * The list carries `html` and `text` in full, not a preview. Both are
     * needed off the list route by two different screens — the editor opens one
     * without a second request, and the broadcast composer decides which
     * templates may be picked at all by looking for the unsubscribe variable in
     * each. Templates are a handful of rows of a few KB; paginating them would
     * cost more than it saves.
     */
    return (await apiFetch<{ items: EmailTemplate[] }>('/admin/email/templates', { signal })).items;
  },

  /** 201. */
  async createTemplate(draft: TemplateDraft): Promise<EmailTemplate> {
    const res = await apiFetch<{ template: EmailTemplate }>('/admin/email/templates', {
      method: 'POST',
      body: draft,
      subject: 'Template',
    });
    return res.template;
  },

  /**
   * A FULL replacement, not a partial patch.
   *
   * The editor holds every field in local state and posts all four, so a PATCH
   * that accepted three of them would let a stale tab blank a body it never
   * showed. Saving a template with no `{{unsubscribe_url}}` is allowed here and
   * refused at `send` — HANDOFF §3 B4's rule, and the reason is that a
   * half-written template is a normal state to save and an abnormal state to
   * broadcast.
   */
  async updateTemplate(id: string, draft: TemplateDraft): Promise<EmailTemplate> {
    const res = await apiFetch<{ template: EmailTemplate }>(`/admin/email/templates/${seg(id)}`, {
      method: 'PATCH',
      body: draft,
      id,
      subject: 'Template',
    });
    return res.template;
  },

  async deleteTemplate(id: string): Promise<void> {
    await apiFetch<{ ok: true }>(`/admin/email/templates/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Template',
    });
  },

  // ----------------------------------------------------------- subscribers
  /** Keyset, like every other list in this app: `nextCursor` or null. */
  async listSubscribers(
    query: { filter?: SubscriberFilter; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<EmailSubscriber>> {
    return apiFetch<Page<EmailSubscriber>>('/admin/email/subscribers', {
      query: { ...query },
      signal,
    });
  },

  /** The counts the confirm dialog is built on. See `Audience`. */
  async audience(signal?: AbortSignal): Promise<Audience> {
    return apiFetch<Audience>('/admin/email/audience', { signal });
  },

  /** 201. `source: 'manual'` is set server-side; the client cannot claim one. */
  async addSubscriber(email: string): Promise<EmailSubscriber> {
    const res = await apiFetch<{ subscriber: EmailSubscriber }>('/admin/email/subscribers', {
      method: 'POST',
      body: { email },
      subject: 'Subscriber',
    });
    return res.subscriber;
  },

  /**
   * Validate-all-then-write, `/api/import`'s rule: either every address in the
   * body is acceptable or none of them is written. The screen has already shown
   * the writer which rows would be refused, so a partial write here would mean
   * the preview they approved and the list they got are different things.
   */
  async importSubscribers(emails: string[]): Promise<SubscriberImportResult> {
    const body: SubscriberImport = { emails, consent: true };
    return apiFetch<SubscriberImportResult>('/admin/email/subscribers/import', {
      method: 'POST',
      body,
    });
  },

  // ------------------------------------------------------------ broadcasts
  async listBroadcasts(signal?: AbortSignal): Promise<EmailBroadcast[]> {
    return (await apiFetch<{ items: EmailBroadcast[] }>('/admin/email/broadcasts', { signal }))
      .items;
  },

  async getBroadcast(id: string, signal?: AbortSignal): Promise<EmailBroadcast> {
    const res = await apiFetch<{ broadcast: EmailBroadcast }>(
      `/admin/email/broadcasts/${seg(id)}`,
      { id, subject: 'Broadcast', signal },
    );
    return res.broadcast;
  },

  /**
   * 201, and it SENDS NOTHING. Creating a broadcast snapshots the template into
   * a `draft` row and builds its recipient set; `send` is a separate request
   * behind a separate confirmation. The two are split precisely so the screen
   * can show a real recipient count for this exact broadcast before anybody
   * agrees to anything.
   */
  async createBroadcast(templateId: string): Promise<EmailBroadcast> {
    const res = await apiFetch<{ broadcast: EmailBroadcast }>('/admin/email/broadcasts', {
      method: 'POST',
      body: { templateId },
      subject: 'Broadcast',
    });
    return res.broadcast;
  },

  /**
   * Renders the snapshot and sends it TO THE CALLER'S OWN ADDRESS ONLY.
   *
   * The route takes no recipient (§2 A6) and this method deliberately offers no
   * way to pass one: "send a test to someone else" is a broadcast to an audience
   * of one, wearing a button that does not warn about it.
   */
  async sendTest(id: string): Promise<void> {
    await apiFetch<{ sent: true }>(`/admin/email/broadcasts/${seg(id)}/test`, {
      method: 'POST',
      id,
      subject: 'Broadcast',
    });
  },

  /**
   * THE IRREVERSIBLE ONE. Flips the row to `sending` and drains a first batch
   * inline, answering with the row as it stands after that batch.
   *
   * Nothing in this module calls it without a confirmation naming the count;
   * that is `EmailBroadcasts.tsx`'s job and the single most important control on
   * the surface.
   */
  async sendBroadcast(id: string): Promise<EmailBroadcast> {
    const res = await apiFetch<{ broadcast: EmailBroadcast }>(
      `/admin/email/broadcasts/${seg(id)}/send`,
      { method: 'POST', id, subject: 'Broadcast' },
    );
    return res.broadcast;
  },

  /**
   * Sends the next batch of an already-started broadcast.
   *
   * THE DAILY CRON OWNS THIS (§2 A6 — Vercel Hobby allows one run a day and the
   * drain is folded into it). The button that calls it from the progress view
   * exists for the operator who does not want to wait until tomorrow, not
   * because the send depends on a browser staying open. Concurrent drains are
   * safe by construction: recipients are claimed by CAS, the same way the order
   * outbox claims intents.
   */
  async drainBroadcast(id: string): Promise<EmailBroadcast> {
    const res = await apiFetch<{ broadcast: EmailBroadcast }>(
      `/admin/email/broadcasts/${seg(id)}/drain`,
      { method: 'POST', id, subject: 'Broadcast' },
    );
    return res.broadcast;
  },
};

export type EmailApi = typeof emailApi;
