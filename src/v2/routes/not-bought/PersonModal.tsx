import { shopApi, type ShopBasketLine } from '../../../data/api-shop';
import { marketingApi } from '../../../data/api-marketing';
import { useAsync } from '../../lib/useAsync';
import { money, dateTime } from '../../lib/format';
import { Modal } from '../../ui/Modal';
import { StoredImg } from '../../ui/Img';
import { Badge, Banner, Spinner, type BadgeTone } from '../../ui/primitives';

/**
 * The person modal on "Not bought yet" — what they actually left in the
 * basket, quoted live (`shopApi.getProspect`), plus their points balance
 * (`marketingApi.getCustomer`, the same route the customer screen reads).
 *
 * Send history (`email_broadcast_recipients` joined to `email_broadcasts`) has
 * no client API yet — nothing in `src/data/api-marketing.ts` or `api-shop.ts`
 * reaches it, and this is a UI task, so that section is left out rather than
 * wired to a route invented here. Production has zero broadcasts today
 * either way.
 */

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
      </div>
    </Modal>
  );
}
