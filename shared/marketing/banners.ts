/**
 * FROZEN at stream fork 2026-08-13 — edits require both streams' consent.
 *
 * WHETHER A BANNER IS SHOWING, decided once for both sides of the wire.
 *
 * The public endpoint evaluates the schedule in its WHERE clause at read time
 * (there is no cron to flip a status — Vercel Hobby's two daily slots are
 * already spent, and a banner that goes live at 9am should go live at 9am), and
 * the admin list renders a status chip for the same row. Those are two
 * implementations of one rule, and the failure mode when they disagree is the
 * worst kind: the admin screen says Live, the site shows nothing, and nobody
 * can tell which one is lying. So the rule is a pure function here, the client
 * calls it directly, and the server has a parity test that feeds these same
 * fixtures to both this function and the SQL predicate.
 *
 * `status` is the stored intent (draft / live / archived); the derived status is
 * intent crossed with the clock.
 */

export type DerivedBannerStatus = 'draft' | 'scheduled' | 'live' | 'ended' | 'archived';

export interface BannerSchedule {
  status: 'draft' | 'live' | 'archived';
  /** Epoch ms. Null means "from the moment it is live". */
  startsAt: number | null;
  /** Epoch ms, exclusive. Null means "until someone turns it off". */
  endsAt: number | null;
}

/**
 * Order matters and encodes the precedence the operator expects: an archived
 * banner is archived whatever its dates say, a draft is a draft whatever its
 * dates say, and only a row someone has actually switched on gets measured
 * against the clock.
 *
 * Boundaries: `startsAt === now` is LIVE (a banner scheduled for 09:00 is
 * showing at 09:00) and `endsAt === now` is ENDED (the window is half-open, so
 * a back-to-back pair never both show). The SQL predicate is written
 * `starts_at <= $now AND ends_at > $now` to match exactly.
 */
export function deriveBannerStatus(banner: BannerSchedule, now: number): DerivedBannerStatus {
  if (banner.status === 'archived') return 'archived';
  if (banner.status === 'draft') return 'draft';
  if (banner.startsAt !== null && banner.startsAt > now) return 'scheduled';
  if (banner.endsAt !== null && banner.endsAt <= now) return 'ended';
  return 'live';
}
