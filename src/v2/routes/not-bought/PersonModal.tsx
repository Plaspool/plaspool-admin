import { shopApi, type ShopBasketLine, type ShopSend } from '../../../data/api-shop';
import { marketingApi } from '../../../data/api-marketing';
import { useAsync } from '../../lib/useAsync';
import { money, dateTime } from '../../lib/format';
import { Modal } from '../../ui/Modal';
import { StoredImg } from '../../ui/Img';
import { Timeline, type TimelineEvent } from '../../ui/Timeline';
import { Badge, Banner, Spinner, type BadgeTone } from '../../ui/primitives';

/**
 * The person modal on "Not bought yet" — what they actually left in the
 * basket, quoted live (`shopApi.getProspect`), plus their points balance
 * (`marketingApi.getCustomer`, the same route the customer screen reads) and
 * what the shop has emailed them (also `shopApi.getProspect`, `sends`, added
 * by task 10b once the server route existed to read it).
 */

/** Display strings for `Send['status']` — the wire values (`pending`, `sent`,
 *  `failed`, `skipped`) do not move. */
const SEND_STATE: Record<string, { label: string; tone: 'neutral' | 'ok' | 'critical' | 'info' }> = {
  pending: { label: 'Queued', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'ok' },
  failed: { label: 'Failed', tone: 'critical' },
  skipped: { label: 'Not sent', tone: 'neutral' },
};

/** Plain words for why a send was skipped. `basket_empty` is the ordinary
 *  one — their basket emptied between the pick and the batch. */
function skipReason(lastError: string | null): string {
  if (lastError === 'basket_empty') return 'Their basket was empty by the time it went out.';
  if (lastError === 'unsubscribed') return 'They had already unsubscribed.';
  return lastError ?? 'It did not go out.';
}

function sendToEvent(send: ShopSend): TimelineEvent {
  const state = SEND_STATE[send.status] ?? { label: send.status, tone: 'neutral' as const };
  const when = send.sentAt ? dateTime(send.sentAt) : null;
  return {
    id: send.broadcastId,
    message: send.subject,
    meta: (
      <span className="row" style={{ gap: 'var(--s2)', alignItems: 'center' }}>
        <Badge tone={state.tone}>{state.label}</Badge>
        {when ? <span>{when}</span> : null}
        {send.status === 'skipped' ? <span>{skipReason(send.lastError)}</span> : null}
        {send.status === 'failed' && send.lastError ? <span>{send.lastError}</span> : null}
      </span>
    ),
    tone: state.tone,
  };
}

/** Display strings only — the wire values (`open`, `converting`, `converted`,
 *  `abandoned`) do not move. `converting` gets its own line because it is the
 *  highest-intent state on the whole screen: somebody who reached the payment
 *  step and stopped. Lumping it in with "open" would hide the best group an
 *  operator has. */
const CART_STATE: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: 'Basket open', tone: 'info' },
  converting: { label: 'Started checkout', tone: 'warn' },
  converted: { label: 'Checked out', tone: 'ok' },
  abandoned: { label: 'Abandoned', tone: 'neutral' },
};

function BasketLine({ line, currency }: { line: ShopBasketLine; currency: string }) {
  const options = Object.values(line.optionValues ?? {}).filter(Boolean).join(' · ');
  return (
    <div className="row" style={{ alignItems: 'center', gap: 'var(--s3)' }}>
      {/* No placeholder box for a line with no photograph — a grey box reads
          the same as a broken image, and the emails already made that call. */}
      {line.imageId ? (
        <span className="idcell__thumb" aria-hidden="true" style={{ flex: '0 0 auto' }}>
          <StoredImg id={line.imageId} alt={line.title} />
        </span>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{line.title}</div>
        <div className="meta">
          {[options, line.sku ? `Product code ${line.sku}` : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="num" style={{ flex: '0 0 auto', textAlign: 'right' }}>
        <div>
          {line.qty} × {money(line.unitMinor, currency)}
        </div>
        <strong>{money(line.lineMinor, currency)}</strong>
      </div>
    </div>
  );
}

export function PersonModal({ email, onClose }: { email: string; onClose: () => void }) {
  const { data, error, loading } = useAsync((signal) => shopApi.getProspect(email, signal), [email]);
  /* Points is its own load — a stall or a 403 on the ledger side must not
     block the basket from rendering. */
  const points = useAsync((signal) => marketingApi.getCustomer(email, signal), [email]);

  const basket = data?.basket ?? null;
  const sends = data?.sends ?? [];
  const state = basket ? (CART_STATE[basket.status] ?? { label: basket.status, tone: 'neutral' as BadgeTone }) : null;

  return (
    <Modal title={email} onClose={onClose} wide>
      <div className="stack">
        {error ? (
          <Banner tone="critical" title="Couldn’t load their basket">
            {error}
          </Banner>
        ) : null}

        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--s6)' }}>
            <Spinner />
          </div>
        ) : null}

        {!loading && !error && !basket ? (
          <p className="meta">No basket to show — it’s empty, or it’s already checked out.</p>
        ) : null}

        {basket ? (
          <>
            <div className="stack stack--tight">
              {basket.lines.map((line) => (
                <BasketLine key={line.variantId} line={line} currency={basket.currency} />
              ))}
            </div>

            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>Total</strong>
              <strong className="num">{money(basket.totalMinor, basket.currency)}</strong>
            </div>

            <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
              {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
              {basket.discountCode ? <Badge tone="info">Code {basket.discountCode}</Badge> : null}
            </div>

            <div className="defs">
              <div className="defs__row">
                <span className="defs__label">Last touched</span>
                <span className="defs__value">{dateTime(basket.updatedAt)}</span>
              </div>
              <div className="defs__row">
                <span className="defs__label">Expires</span>
                <span className="defs__value">{basket.expiresAt ? dateTime(basket.expiresAt) : '—'}</span>
              </div>
              {basket.redemptionPoints ? (
                <div className="defs__row">
                  <span className="defs__label">Spending points</span>
                  <span className="defs__value">{basket.redemptionPoints}</span>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {points.data ? (
          <div className="defs">
            <div className="defs__row">
              <span className="defs__label">Points history</span>
              <span className="defs__value">{points.data.balance}</span>
            </div>
          </div>
        ) : null}

        {!loading ? (
          <div className="stack stack--tight">
            <strong>Sent to them</strong>
            {sends.length > 0 ? (
              <Timeline events={sends.map(sendToEvent)} />
            ) : (
              <p className="meta">We haven’t sent them anything yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
