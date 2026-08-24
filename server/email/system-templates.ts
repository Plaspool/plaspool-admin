/**
 * The bridge between `server/mail/defaults.ts` (the wording, in code) and
 * `email_templates` (the wording, editable by an owner).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  EVERY FUNCTION IN THIS FILE IS TOTAL. NONE OF THEM THROWS. ⚠️
 *
 * This is not a style preference, it is the property that makes the whole
 * feature safe to ship, and the next person to add a `throw` here should read
 * this paragraph first.
 *
 * `server/shop/orders/repo/orders.ts` renders a customer's message and writes it
 * in the SAME STATEMENT as the state change that owed it — the capture, the
 * cancellation, the refund. That is the outbox design and it is deliberate: a
 * mail failure must never roll back an order that genuinely happened. Reading a
 * template from the database introduces a step that CAN fail, and the only way
 * that step is admissible at all is if its failure mode is "use the built-in
 * default" rather than "raise". A `throw` in this file is a `throw` inside a
 * payment capture.
 *
 * So: a missing row falls back. A row with an empty body falls back. A database
 * that is down falls back. A key nobody recognises falls back. In every case the
 * customer receives the correct, branded, built-in message and the operator's
 * edit is the only thing lost — which is recoverable, unlike the payment.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { listSystemTemplates, seedSystemTemplate } from './repo';
import { DEFAULT_TEMPLATES, SYSTEM_KEYS, defaultTemplate } from '../mail/defaults';
import type { SystemKey } from '../mail/defaults';
import { render } from '../mail/transactional';
import type { TemplateBody } from '../mail/transactional';
import type { Db } from '../db/client';

/**
 * The templates in force, resolved once and then read synchronously.
 *
 * SYNCHRONOUS LOOKUP IS THE WHOLE REASON THIS TYPE EXISTS. The render happens
 * deep inside a statement builder — `MARK_PAID.effects()`, which is a pure
 * function that composes SQL — and making that async would mean an `await`
 * inside the construction of a guarded UPDATE. Resolving the set ONCE per sweep
 * pass and passing it down as data keeps the write path exactly as it is.
 */
export interface TemplateSet {
  get(key: SystemKey): TemplateBody;
}

/** The built-ins, as a `TemplateSet`. What every fallback resolves to. */
export const BUILT_IN: TemplateSet = {
  get(key) {
    const t = defaultTemplate(key);
    return { subject: t.subject, html: t.html, text: t.text };
  },
};

/**
 * A row is only allowed to override a default if it is actually usable.
 *
 * AN EMPTY BODY IS THE CASE THIS EXISTS FOR, and it is reachable: the database
 * CHECK (`email_templates_bodies_ck`) refuses empty strings, but it says nothing
 * about a body that is only whitespace, and an owner who selects-all-and-deletes
 * in the editor and saves produces exactly that. Sending it would deliver a blank
 * message to a paying customer. Falling back sends the default, which is wrong in
 * the sense that it ignores an edit, and right in every sense that matters.
 */
function usable(row: { subject: string; html: string; text: string }): boolean {
  return (
    row.subject.trim() !== '' && row.html.trim() !== '' && row.text.trim() !== ''
  );
}

/**
 * Read the system templates, falling back to the built-ins for anything missing,
 * unusable, or unreadable.
 *
 * THE `catch` RETURNS `BUILT_IN` RATHER THAN RE-THROWING — see the header. The
 * error is logged because an operator's edits silently not applying is exactly
 * the kind of failure that otherwise goes unnoticed for months; it is logged with
 * name and message only, the shape `server/middleware/errors.ts` requires,
 * because a driver error can carry the query and the query carries addresses.
 */
export async function loadTemplates(db: Db): Promise<TemplateSet> {
  let rows: Awaited<ReturnType<typeof listSystemTemplates>>;
  try {
    rows = await listSystemTemplates(db);
  } catch (err: unknown) {
    // eslint-disable-next-line no-console -- an unnoticed fallback is the bug
    console.error(
      '[email/system-templates]',
      JSON.stringify({
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : 'template read failed',
        effect: 'using built-in templates',
      }),
    );
    return BUILT_IN;
  }

  const overrides = new Map<string, TemplateBody>();
  for (const row of rows) {
    if (row.systemKey === null || !usable(row)) continue;
    overrides.set(row.systemKey, {
      subject: row.subject,
      html: row.html,
      text: row.text,
    });
  }

  return {
    get: (key) => overrides.get(key) ?? BUILT_IN.get(key),
  };
}

/**
 * Create any system template that is not in the table yet. Idempotent, and it
 * NEVER OVERWRITES.
 *
 * "NEVER OVERWRITES" IS THE CONTRACT AN OWNER IS RELYING ON. If this upserted,
 * every deploy would silently revert their wording — and they would find out from
 * a customer, because nobody re-reads the refund email. `seedSystemTemplate` is
 * `INSERT … WHERE NOT EXISTS`, so an edited row is invisible to it forever.
 *
 * WHERE IT RUNS: the admin templates list, and the sweep. Not at boot — this app
 * has no boot, it is a lambda that starts on a request, and putting a write of
 * one row per system message in front of the first request after a cold start
 * would put it in front of a customer's checkout. Running it from the templates
 * screen means it happens the first time an operator looks, which is the first
 * time it can possibly matter; running it from the sweep means a deployment
 * nobody visits still ends up seeded.
 *
 * Returns how many rows it created, for the caller's log. Never throws: a seed
 * failure must not turn the templates screen into a 500, and it must certainly
 * not stop a sweep that is also delivering mail and draining payments.
 */
export async function ensureSystemTemplates(db: Db, now: number): Promise<number> {
  let created = 0;
  for (const key of SYSTEM_KEYS) {
    const t = DEFAULT_TEMPLATES[key];
    try {
      const row = await seedSystemTemplate(
        db,
        {
          name: t.name,
          subject: t.subject,
          html: t.html,
          text: t.text,
          systemKey: t.key,
        },
        now,
      );
      if (row !== null) created += 1;
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- see loadTemplates
      console.error(
        '[email/system-templates]',
        JSON.stringify({
          key,
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : 'seed failed',
        }),
      );
    }
  }
  return created;
}

/**
 * Render one system message ready for `server/mail/port.ts`.
 *
 * THE CONVENIENCE FUNCTION FOR CALLERS THAT SEND IMMEDIATELY — the auth routes
 * and the welcome mail — as against the order pipeline, which renders inside a
 * statement builder and therefore takes a resolved `TemplateSet` instead.
 *
 * NO BLOCKS, ONLY SCALARS. None of the messages that come through here has a line
 * table or a timeline; giving the parameter a block channel would invite somebody
 * to pass HTML assembled from a request, which is the one thing
 * `transactional.ts` keeps out by type.
 *
 * `support_email` IS FILLED IN HERE so no caller has to remember it. Every default
 * footer references it, and a caller that forgot would ship a footer reading
 * "write to {{support_email}}".
 *
 * NEVER THROWS, for the reason the whole file gives: `loadTemplates` degrades to
 * the built-ins, and the built-ins are complete messages.
 */
export async function renderSystem(
  db: Db,
  key: SystemKey,
  to: string,
  scalars: Record<string, string>,
): Promise<{ to: string; subject: string; text: string; html: string }> {
  const set = await loadTemplates(db);
  const message = render(set.get(key), to, {
    scalars: { support_email: supportEmail(), ...scalars },
    blocks: {},
  });
  return {
    to: message.to,
    subject: message.subject,
    text: message.body,
    html: message.html,
  };
}

/**
 * The address the footers point at.
 *
 * A SECOND COPY of the helper in `server/shop/orders/mailer.ts`, which is a small
 * duplication taken deliberately rather than a shared module: importing that file
 * here would pull the entire order-mail subsystem — line tables, timelines, the
 * `AccessLink` type — into the auth routes, which have no orders in them. Both
 * copies fall back the same way, and the fallback chain is the part that matters:
 * never the empty string, because a footer reading "write to us at" with nothing
 * after it reads as no support at all rather than as a bug.
 */
function supportEmail(): string {
  const explicit = process.env.SHOP_SUPPORT_EMAIL?.trim();
  if (explicit) return explicit;
  const from = process.env.MAIL_FROM?.trim();
  const angled = from?.match(/<([^>]+)>/);
  if (angled) return angled[1];
  if (from) return from;
  return 'support@plaspool.com';
}
