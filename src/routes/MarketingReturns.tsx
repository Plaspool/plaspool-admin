import './marketing.css';

/**
 * PLACEHOLDER, replaced whole by plan Tasks B3 (queue) and B4 (detail).
 *
 * One route renders both halves: the queue, and the detail when `?id=` is
 * present — the list-plus-detail-in-a-query-param convention `ShopProducts`
 * already uses, so Back leaves the section instead of walking a stack of
 * records.
 */
export default function MarketingReturns() {
  return (
    <div className="mktscr">
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <h1 className="mktscr__title">Returns</h1>
        </div>
        <p className="mktscr__lede">
          Oldest first — schedule, receive, inspect, award. This screen is being built.
        </p>
      </header>
    </div>
  );
}
