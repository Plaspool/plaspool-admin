import './marketing.css';

/**
 * PLACEHOLDER, replaced whole by plan Task B5.
 *
 * It exists at the fork so the route table, the sidebar and the section's
 * stylesheet are registered and typechecking in ONE commit, before the backend
 * and frontend streams start working in parallel. A screen that does not exist
 * yet still has to route to something, and a 404 would look like a bug in the
 * navigation rather than work in progress.
 */
export default function MarketingOverview() {
  return (
    <div className="mktscr">
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <h1 className="mktscr__title">Marketing</h1>
        </div>
        <p className="mktscr__lede">
          Rewards, returns and site banners. This screen is being built.
        </p>
      </header>
    </div>
  );
}
