import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { shopApi } from '../../data/api-shop';
import { ForbiddenError } from '../../data/errors';
import { useAsync } from '../lib/useAsync';
import { money } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Banner, ButtonLink } from '../ui/primitives';
import { BoxArt, CouponArt, PageArt, PeopleArt, ReceiptArt, ShelfArt } from '../ui/illustrations';

/**
 * HOME — the front door, and it holds NO TABLE.
 *
 * The one-table-per-page rule reads strongest here: a table on Home would be
 * a second Orders screen, and the real one is a click away. Home is a
 * LAUNCHER — a bento of the six places work happens, each carrying its drawn
 * illustration as the picture and, where the stats endpoint offers one for
 * free, a real number.
 *
 * THE ARRANGEMENT IS 2 / 3 / 1 ON PURPOSE. A uniform grid of equal cards
 * reads as a settings page; the uneven rhythm — two wide, three even, one
 * full-width — is what makes it read as a composed front page. Orders gets
 * the big cell because orders are the job.
 *
 * Motion lives in `page.css` (`.bento`): staggered rise-in on mount, spring
 * lift + counter-rotating art + arrow-chip fill on hover. All transform and
 * opacity, all collapsed by prefers-reduced-motion.
 */
export default function Home() {
  const [shown, toggle] = useAnalyticsBar('home');
  /* THE 403 IS A SCOPED HOME, NOT A BROKEN ONE. Stats sit in the analytics
     domain, which a content writer does not hold — so for them the endpoint
     answers 403 by design. The launcher below is still their front door:
     swallow the refusal into "no data" (no tiles, no alert banners) rather
     than letting it paint the load-failure banner over a page that works. */
  const { data, error } = useAsync(
    (signal) =>
      shopApi.stats({}, signal).catch((cause: unknown) => {
        if (cause instanceof ForbiddenError) return null;
        throw cause;
      }),
    [],
  );

  const metrics = useMemo<Metric[]>(() => {
    if (!data) return [];
    /* Revenue is grouped BY CURRENCY because two ISO codes cannot be added.
       One row exists today; labelling it with its own currency is what keeps
       this honest the day there are two. */
    const rev = data.revenue[0];
    const orderCount = data.ordersByStatus.reduce((n, r) => n + r.count, 0);
    const paid = data.ordersByStatus.find((r) => r.status === 'paid')?.count ?? 0;
    const pending = data.ordersByStatus.find((r) => r.status === 'pending')?.count ?? 0;
    return [
      { label: 'Revenue · 24h', value: rev ? money(rev.last24h, rev.currency) : '—' },
      {
        label: 'Revenue · 7d',
        value: rev ? money(rev.last7d, rev.currency) : '—',
        /* Three real points, oldest first — the three windows the endpoint
           actually answers. Not a daily series; not invented. */
        series: rev ? [rev.last30d / 30, rev.last7d / 7, rev.last24h] : undefined,
      },
      { label: 'Orders all time', value: String(orderCount) },
      { label: 'Awaiting payment', value: String(pending) },
      { label: 'Paid', value: String(paid) },
      { label: 'Low stock', value: `${data.lowStock.length}${data.lowStockMore ? '+' : ''}` },
    ];
  }, [data]);

  const orderCount = data ? data.ordersByStatus.reduce((n, r) => n + r.count, 0) : null;
  const lowStock = data ? data.lowStock.length : 0;
  const stuck = data?.emails.stuck ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Home"
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      <div className="home__greet">
        <h1>PlaSpool is open for business.</h1>
        <p>What do you want to work on next?</p>
      </div>

      {/* No metrics means loading OR a scoped role — an empty bar frame would
          claim numbers exist that never will. */}
      {shown && metrics.length > 0 ? <AnalyticsBar range="Store total" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load the store summary">
          {error}
        </Banner>
      ) : null}

      {stuck > 0 ? (
        <Banner
          tone="critical"
          title={`${stuck} email${stuck === 1 ? '' : 's'} will never send`}
          action={<ButtonLink to="/emails/outbox">Open the outbox</ButtonLink>}
        >
          These are out of retry attempts. Retry or dismiss them from the outbox.
        </Banner>
      ) : null}

      <div className="bento">
        <Link to="/orders" className="bento__card bento__card--a">
          <span className="bento__art">
            <ReceiptArt />
          </span>
          {orderCount !== null ? <span className="bento__stat num">{orderCount}</span> : null}
          <span className="bento__kicker">Orders</span>
          <span className="bento__title">Work through orders</span>
          <span className="bento__body">
            Fulfil what is paid for, chase what is not, and refund what came back.
          </span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>

        <Link to="/discounts" className="bento__card bento__card--b">
          <span className="bento__art">
            <CouponArt />
          </span>
          <span className="bento__kicker">Discounts</span>
          <span className="bento__title">Set up a discount</span>
          <span className="bento__body">
            A code a customer types at checkout — a percentage or a flat amount off.
          </span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>

        <Link to="/products" className="bento__card bento__card--c">
          <span className="bento__art">
            <BoxArt />
          </span>
          <span className="bento__kicker">{lowStock > 0 ? `${lowStock} low on stock` : 'Products'}</span>
          <span className="bento__title">Check the catalogue</span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>

        <Link to="/customers" className="bento__card bento__card--d">
          <span className="bento__art">
            <PeopleArt />
          </span>
          <span className="bento__kicker">Customers</span>
          <span className="bento__title">Look up a customer</span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>

        <Link to="/products/categories" className="bento__card bento__card--e">
          <span className="bento__art">
            <ShelfArt />
          </span>
          <span className="bento__kicker">Categories</span>
          <span className="bento__title">Tidy the categories</span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>

        <Link to="/content/posts" className="bento__card bento__card--f">
          <span>
            <span className="bento__kicker">Content</span>
            <span className="bento__title">Write for the blog</span>
            <span className="bento__body">
              The publication side of the shop — drafts, published posts and word counts.
            </span>
          </span>
          <span className="bento__art">
            <PageArt />
          </span>
          <span className="bento__go" aria-hidden="true">
            <ArrowRight />
          </span>
        </Link>
      </div>
    </div>
  );
}
