import { Link } from 'react-router-dom';
import { TicketPercent } from 'lucide-react';
import './marketing.css';

/**
 * The section's sixth screen, and the only one with nothing behind it.
 *
 * IT FETCHES NOTHING, AND THAT IS THE DESIGN RATHER THAN THE SHORTCUT. The
 * server half of discount codes exists — the table, the CHECKs, the CRUD — so a
 * list here would be twenty lines and would work. It is not written, because a
 * table of codes implies the codes are the feature, and the feature is the half
 * nobody has built: what a code does to a cart at checkout. A placeholder that
 * can spin, time out or render "couldn't load discounts" is worse than no
 * placeholder at all — it turns "not built yet" into "broken", which is the one
 * reading this screen must never allow. So there is no state in this file, no
 * effect, no error path and nothing to retry.
 *
 * NO DEAD CONTROLS EITHER. The single control is a link to a screen that
 * exists and does something; a disabled "New code" button here would be an
 * invitation with nothing behind it, and it is the first thing an owner would
 * press.
 *
 * AND IT NAMES NO CURRENCY. The word for what customers earn is configuration
 * (spec D2), read from the settings row at use time — and this screen has no
 * settings row, because it asks the server for nothing. Every sentence below is
 * therefore written label-free by construction: nothing here can interpolate a
 * label, so nothing here may assume one. Its own suite pins that.
 */
export default function MarketingDiscounts() {
  return (
    <div className="mktscr">
      {/* No lede. The other five screens explain themselves above the fold
          because there is something under it to explain; here the panel below
          is the entire content, and a sentence describing discount codes
          directly above a panel describing discount codes is the same sentence
          twice. The 404 branch of the banners editor makes the same call. */}
      <header className="mktscr__head">
        <h1 className="mktscr__title">Discounts</h1>
      </header>

      <div className="mktscr__body">
        <section className="mktsoon">
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <TicketPercent />
            </div>
            <span className="chip">Planned</span>
            <h2 className="empty__title">Discount codes aren’t built yet</h2>
            <p className="empty__body">
              The plan is a code you can hand out — one that takes either a percentage or a flat
              amount off a cart, with a window it works in and a limit on how often. It reaches the
              total as one named line against the order rather than as a second set of prices, so a
              cart never has two ideas about what it costs.
            </p>
            {/*
              THE HONEST VERSION OF "SEE REWARDS". The spec's line for this
              paragraph reads that redeemed rewards already discount checkout;
              its own Deferred list says the opposite in more words — the
              redemption seam is written and tested, and the shop's checkout
              still hard-codes an empty adjustments array at the one call site
              that would use it (spec D9). Both halves of the sentence below are
              true today: the mechanism is real, the wiring is somebody else's
              file. Claiming the wiring on the section's honesty screen would be
              the exact failure this page exists to avoid.
            */}
            <p className="empty__body">
              Rewards is the half of this that already exists: it turns what a customer has earned
              into a single named line off an order, and a code will use that same line rather than
              inventing a second way to make a cart cheaper.
            </p>
            <Link className="btn btn--outline" to="/marketing/rewards">
              Open Rewards
            </Link>
            <ul className="mktsoon__later" aria-label="Left for later">
              <li>Stacking rules — whether a code and a reward may meet on one cart.</li>
              <li>Per-customer limits — one use each, or one use in total.</li>
              <li>Auto-apply — a discount that lands without anybody typing it.</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
