import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { emailApi, type EmailTemplate } from '../../../data/api-email';
import { shopApi, type ShopProspect } from '../../../data/api-shop';
import { hasUnsubscribeVariable, needsBasket } from '../../../../shared/email/variables';
import { useAsync } from '../../lib/useAsync';
import { money } from '../../lib/format';
import { Modal } from '../../ui/Modal';
import { Banner, Button, Spinner } from '../../ui/primitives';
import { SelectField } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

/**
 * THE SEND — the only irreversible control on "Not bought yet".
 *
 * An operator ticks people on the list, picks one message, and everybody ticked
 * gets it. There is no recall, so this screen's whole job is to be honest about
 * WHO before the press: the three counts below are computed from the same facts
 * the server acts on, not from the length of the selection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PREDICATE IS `needsBasket`, OVER THE SUBJECT AND BOTH BODIES.
 *
 * `drainBroadcast` (`server/email/send.ts`) decides whether to resolve a
 * basket — and therefore whom to SKIP — with exactly that expression. The
 * narrower `usesBasket` matches only the `{{basket}}` block, so a template
 * written "Your basket is worth {{basket_total}}" would read here as needing
 * no basket while the server skipped every empty-basket recipient. The warning
 * would then be a promise about the send that the send does not keep, which is
 * worse than no warning: an operator who is told nobody is left out has no
 * reason to look afterwards.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO CALLS, THE SAME TWO THE NEWSLETTERS SCREEN MAKES. `createBroadcast`
 * snapshots the template into a draft and names this audience; `sendBroadcast`
 * is the irreversible half. That is deliberate rather than incidental — a
 * picked send is an ordinary broadcast, so it appears in Newsletters with its
 * own progress and its own record, and there is no second send log to keep in
 * step with the first.
 */

/** A template's own gate. `missingUnsubscribe` in `api-email.ts` exempts
 *  SYSTEM templates because an order confirmation is not marketing — that
 *  exemption has no place here, where every send is marketing by definition,
 *  so the predicate is read straight. */
function noWayOut(t: EmailTemplate): boolean {
  return !hasUnsubscribeVariable(t.html) || !hasUnsubscribeVariable(t.text);
}

/** Does this message need each reader's basket resolved? The drain's own
 *  expression, character for character. */
function wantsBasket(t: EmailTemplate): boolean {
  return needsBasket(t.subject) || needsBasket(t.html) || needsBasket(t.text);
}

export function SendModal({
  picked,
  onClose,
  onSent,
}: {
  picked: ShopProspect[];
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const templates = useAsync((signal) => emailApi.listTemplates(signal), []);
  const [templateId, setTemplateId] = useState('');
  const [sending, setSending] = useState(false);
  /* Set the moment `createBroadcast` resolves, and never cleared. A failure
     AFTER this point means a draft exists with the picked audience already
     attached — pressing Send again would mint a SECOND draft over the same
     addresses, and because the server drains a first batch before responding
     (`server/routes/email.ts`), a "failed" send can mean mail already went
     out. So this flag, once true, disables the button for good — the operator
     has to finish or abandon the draft under Newsletters, not retry here. */
  const [stranded, setStranded] = useState(false);

  const list = templates.data ?? [];
  const template = list.find((t) => t.id === templateId) ?? null;

  /**
   * THE THREE COUNTS, EACH OF THEM A CLAIM ABOUT WHAT THE SERVER WILL DO.
   *
   *  - `mailable` — everybody NOT suppressed. `enqueueAudience` enrols a picked
   *    address as a subscriber and then selects `WHERE unsubscribed_at IS NULL`,
   *    and `addSubscriber` never resurrects an opted-out row; the drain checks
   *    again after the claim. So an unsubscribed pick is dropped twice and
   *    mailed never.
   *  - `suppressed` — the ones that drop out there. Named out loud because a
   *    silent difference between "3 ticked" and "2 will be emailed" reads as a
   *    bug in the screen rather than as a fact about those people.
   *  - `basketless` — only when the message needs a basket, because only then
   *    does the drain look one up and mark an empty one `skipped`. `hasBasket`
   *    is quoted live by the list route, so this is the same question the drain
   *    asks, a few minutes earlier: somebody who checks out in between is
   *    skipped by the server and not by this count, which is the right way
   *    round — the server has the last word and it errs towards not mailing.
   */
  const counts = useMemo(() => {
    const suppressed = picked.filter((p) => p.subscribeState === 'unsubscribed');
    const mailable = picked.filter((p) => p.subscribeState !== 'unsubscribed');
    return {
      mailable,
      suppressed: suppressed.length,
      basketless: mailable.filter((p) => !p.hasBasket).length,
    };
  }, [picked]);

  const emails = counts.mailable.map((p) => p.email);
  const blocked = template !== null && noWayOut(template);
  const basketNeeded = template !== null && wantsBasket(template);

  /* The preview quotes the FIRST mailable person's real basket rather than an
     invented one — a made-up basket in a preview of a message about somebody's
     real basket is the one thing this panel must not show. */
  const first = counts.mailable[0]?.email ?? null;
  const sample = useAsync(
    (signal) => (first && basketNeeded ? shopApi.getProspect(first, signal) : Promise.resolve(null)),
    [first, basketNeeded],
  );

  async function send() {
    if (template === null || emails.length === 0 || blocked) return;
    setSending(true);
    let draftId: string | null = null;
    try {
      const draft = await emailApi.createBroadcast(template.id, { kind: 'picked', emails });
      draftId = draft.id;
      const sent = await emailApi.sendBroadcast(draft.id);
      toast.show(
        sent.status === 'sent'
          ? `Sent to ${sent.sentCount}`
          : `Sending — ${sent.sentCount} of ${sent.recipientCount} so far`,
      );
      onSent();
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
      if (draftId !== null) {
        /* The draft exists. Pressing Send again would mint a second one over
           the same addresses, and may duplicate mail that already went out —
           so this is NOT a retry. Say where to finish it and leave the button
           disabled for this selection. */
        toast.show(`Draft created but the send didn't start — finish it under Newsletters. ${message}`, 'critical');
        setStranded(true);
        setSending(false);
      } else {
        /* Nothing was created. Safe to retry from here. */
        toast.show(message, 'critical');
        setSending(false);
      }
    }
  }

  const n = counts.mailable.length;

  return (
    <Modal
      title={`Send to ${picked.length} ${picked.length === 1 ? 'person' : 'people'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button tone="plain" onClick={onClose}>
            Cancel
          </Button>
          {/* `busy`, NEVER a label swapped to "Sending…" — `primitives.tsx`
              says why: the button resizes under the cursor mid-press. */}
          <Button
            tone="primary"
            busy={sending}
            disabled={template === null || blocked || n === 0 || stranded}
            onClick={() => void send()}
          >
            <Send aria-hidden="true" />
            Send
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="stack stack--tight">
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <strong>
              {n} will be emailed
            </strong>{' '}
            — this goes out straight away and cannot be recalled.
          </p>
          {counts.suppressed > 0 ? (
            <p className="meta">
              {counts.suppressed} unsubscribed and will be left out.
            </p>
          ) : null}
          {basketNeeded && counts.basketless > 0 ? (
            <p className="meta">
              {counts.basketless} {counts.basketless === 1 ? 'has' : 'have'} no basket and will be
              skipped — this message prints what they left behind.
            </p>
          ) : null}
        </div>

        {n === 0 ? (
          <Banner tone="warn" title="Nobody left to email">
            Everybody picked has unsubscribed.
          </Banner>
        ) : null}

        <SelectField
          label="Message"
          value={templateId}
          disabled={templates.loading}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">Pick a message…</option>
          {list.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>

        {templates.error ? (
          <Banner tone="critical" title="Couldn’t load the messages">
            {templates.error}
          </Banner>
        ) : null}

        {blocked ? (
          <Banner tone="critical" title="No unsubscribe link">
            Both versions of this message need {'{{unsubscribe_url}}'} before it can be sent. Add it
            under Templates.
          </Banner>
        ) : null}

        {template !== null && !blocked ? (
          <div className="stack stack--tight">
            <strong>What they’ll see</strong>
            <p className="meta">Subject: {template.subject}</p>
            {basketNeeded ? (
              sample.loading ? (
                <Spinner />
              ) : sample.data?.basket ? (
                <div className="stack stack--tight">
                  <p className="meta">
                    {first} — {sample.data.basket.lines.length}{' '}
                    {sample.data.basket.lines.length === 1 ? 'line' : 'lines'},{' '}
                    {money(sample.data.basket.totalMinor, sample.data.basket.currency)}
                  </p>
                  {sample.data.basket.lines.map((line) => (
                    <p key={line.variantId} className="meta">
                      {line.qty} × {line.title}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="meta">
                  The first person picked has nothing in their basket, so they’d be skipped.
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
