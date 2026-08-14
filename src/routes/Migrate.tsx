import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Progress, Spinner } from '../components/ui/Feedback';
import { useSession } from '../components/RequireAuth';
import { Switch } from '../components/ui/Switch';
import {
  canRetireLocalCopies,
  migrateLocalPosts,
  retireLocalCopies,
  surveyLocalPosts,
  type MigrationProgress,
  type MigrationReport,
  type MigrationSurvey,
} from '../data/migrate';
import type { LocalPost } from '../data/db';
import type { AuthUser } from '../data/types';
import './settings.css';

/**
 * Uploading the pre-backend library (plan §6.4).
 *
 * WHAT THIS SCREEN IS FOR IS NOT THE UPLOAD. `migrateLocalPosts` does that.
 * This is the disclosure: three things are lost or changed by migrating, and
 * the posts being uploaded predate accounts entirely, so nobody can prove whose
 * they are. Every one of those is stated BEFORE the button rather than in a
 * result screen afterwards, and the button does nothing until the writer has
 * explicitly said yes.
 *
 * **Whose posts are these?** They were written into this browser before it had
 * an account to write them to. There is no owner recorded and there is nothing
 * to check one against — which is why two earlier versions of this plan were
 * wrong to try. On a shared machine, uploading a colleague's drafts under your
 * own name has to be an informed act rather than an accident, so the list names
 * every post and the confirmation names the account. That mitigates the hazard;
 * it does not remove it, and the plan records it as residual.
 *
 * `user` IS A PROP, deliberately. `src/data/session.ts` owns the session and is
 * being written in parallel with this file; taking the user as a prop means
 * this screen has no opinion about how the session is held and the route can be
 * wired with `<Migrate user={user} />` wherever that lands.
 *
 * No new visual vocabulary: the shell, sections and rows are `settings.css`'s,
 * the callouts are `base.css`'s `.notice`, the badges are `.chip`, and the
 * progress bar and switch are the existing `ui/` components. Nothing here
 * hardcodes a colour, so it reads in both themes for the same reason every
 * other screen does.
 */

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** `too_large` → "too large". The reasons are validator enum values. */
const readable = (reason: string): string => reason.replace(/_/g, ' ');

function PostRow({ post }: { post: LocalPost }) {
  return (
    <div className="settings__row">
      <div>
        <p className="settings__label">{post.title || 'Untitled'}</p>
        <p className="settings__hint">Last edited {dateOf(post.updatedAt)}</p>
      </div>
      <span className={`chip chip--${post.status}`}>{post.status}</span>
    </div>
  );
}

export function Migrate({ user }: { user: AuthUser }) {
  const [survey, setSurvey] = useState<MigrationSurvey | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [retirable, setRetirable] = useState(false);
  const [retired, setRetired] = useState<{ posts: number; images: number } | null>(null);
  const [failure, setFailure] = useState('');

  const refresh = useCallback(async () => {
    setSurvey(await surveyLocalPosts());
    setRetirable(await canRetireLocalCopies());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run() {
    setFailure('');
    setReport(null);
    setProgress({
      phase: 'preparing',
      postsPrepared: 0,
      postsTotal: survey?.pending.length ?? 0,
      imagesDone: 0,
      imagesTotal: survey?.imageCount ?? 0,
      postsConfirmed: 0,
    });
    try {
      setReport(await migrateLocalPosts(user.id, setProgress));
    } catch (err) {
      // `migrateLocalPosts` reports its own stops in the report; anything that
      // escapes it is a defect, and saying nothing would leave a spinner.
      setFailure(err instanceof Error ? err.message : 'The upload could not be finished.');
    } finally {
      setProgress(null);
      await refresh();
    }
  }

  async function retire() {
    setFailure('');
    try {
      const removed = await retireLocalCopies();
      setRetired(removed);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The local copies were not removed.');
    } finally {
      await refresh();
    }
  }

  const busy = progress !== null;
  const pending = survey?.pending ?? [];
  const excluded = survey?.excluded ?? [];

  return (
    <div className="settings">
      <header className="settings__bar">
        <Link className="btn btn--ghost btn--sm" to="/dashboard">
          <ChevronLeft className="ui-ic" aria-hidden="true" />
          Posts
        </Link>
        <span className="settings__title">Move posts to the blog</span>
        <span aria-hidden="true" />
      </header>

      <main className="settings__page">
        {survey === null ? (
          <p className="settings__desc">Checking what's on this device…</p>
        ) : pending.length === 0 && excluded.length === 0 ? (
          <section className="settings__section">
            <div className="settings__section-head">
              <h2 className="settings__h">Nothing left to upload</h2>
              <p className="settings__desc">
                {survey.migrated.length > 0
                  ? `All ${survey.migrated.length} ${survey.migrated.length === 1 ? 'post' : 'posts'} written on this device before it was connected are now on the blog.`
                  : 'No posts were written on this device before it was connected to the blog.'}
              </p>
            </div>
          </section>
        ) : (
          <>
            {/*
              THE DISCLOSURE, AND IT IS ABOVE THE BUTTON. Everything a writer
              cannot undo afterwards is here: history is dropped, the revision
              counter restarts, published URLs can move, and the account these
              land under is named. Putting any of it in the result screen would
              be telling them after it happened.
            */}
            <section className="settings__section">
              <div className="settings__section-head">
                <h2 className="settings__h">Before you upload</h2>
                <p className="settings__desc">
                  These {pending.length === 1 ? 'post was' : 'posts were'} written on this device
                  before it was connected to the blog, so there is no record of who wrote{' '}
                  {pending.length === 1 ? 'it' : 'them'}. Uploading publishes{' '}
                  {pending.length === 1 ? 'it' : 'them'} under{' '}
                  <strong>{user.displayName || user.email}</strong>. Check the list below before you
                  do.
                </p>
              </div>

              <div className="settings__rows">
                <div className="settings__row">
                  <div>
                    <p className="settings__label">Edit history is not carried over</p>
                    <p className="settings__hint">
                      {survey.revisionCount > 0
                        ? `${survey.revisionCount} saved ${survey.revisionCount === 1 ? 'snapshot' : 'snapshots'} stay on this device and are not uploaded. Every post arrives on the blog at revision 1, with the words exactly as they are now.`
                        : 'Every post arrives on the blog at revision 1, with the words exactly as they are now.'}
                    </p>
                  </div>
                </div>
                <div className="settings__row">
                  <div>
                    <p className="settings__label">A web address can change</p>
                    <p className="settings__hint">
                      The blog gives each post its own address and will pick a different one if
                      something already has it, so a post that is already published may move.
                    </p>
                  </div>
                </div>
                <div className="settings__row">
                  <div>
                    <p className="settings__label">Nothing is deleted from this device</p>
                    <p className="settings__hint">
                      The local copies stay exactly where they are. Removing them is a separate
                      choice, offered only once every post is on the blog.
                      {survey.imageCount > 0
                        ? ` ${survey.imageCount} ${survey.imageCount === 1 ? 'image is' : 'images are'} uploaded along the way.`
                        : ''}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {pending.length > 0 && (
              <section className="settings__section">
                <div className="settings__section-head">
                  <h2 className="settings__h">
                    {pending.length} {pending.length === 1 ? 'post' : 'posts'} to upload
                  </h2>
                </div>
                <div className="settings__rows">
                  {pending.map((post) => (
                    <PostRow key={post.id} post={post} />
                  ))}
                </div>
              </section>
            )}

            {excluded.length > 0 && (
              <section className="settings__section">
                <div className="settings__section-head">
                  <h2 className="settings__h">
                    {excluded.length} {excluded.length === 1 ? 'post' : 'posts'} can't be uploaded
                  </h2>
                  <p className="settings__desc">
                    The blog won't accept {excluded.length === 1 ? 'this one' : 'these'}, so{' '}
                    {excluded.length === 1 ? 'it is' : 'they are'} left out rather than sent and
                    refused. {excluded.length === 1 ? 'It stays' : 'They stay'} on this device
                    untouched.
                  </p>
                </div>
                <div className="settings__rows">
                  {excluded.map((post) => (
                    <div className="settings__row" key={post.id}>
                      <div>
                        <p className="settings__label">{post.title || 'Untitled'}</p>
                        <p className="settings__hint">
                          {readable(post.reason)}
                          {post.path ? ` — ${post.path}` : ''}
                        </p>
                      </div>
                      <span className="chip">left out</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {pending.length > 0 && (
              <section className="settings__section">
                <div className="settings__rows">
                  <div className="settings__row">
                    <div>
                      <p className="settings__label">
                        Upload {pending.length === 1 ? 'this post' : `these ${pending.length} posts`}{' '}
                        as {user.displayName || user.email}
                      </p>
                      <p className="settings__hint">
                        Turn this on to confirm you want them published under your name.
                      </p>
                    </div>
                    <Switch
                      checked={agreed}
                      onChange={setAgreed}
                      label={`Upload these posts as ${user.displayName || user.email}`}
                    />
                  </div>
                </div>

                {/* `settings__footnote` is the rule-and-spacing the settings
                    page uses to separate an action from the rows above it. A
                    `div`, not the `p` that class usually carries, because the
                    only child is a button. */}
                <div className="settings__footnote">
                  <button
                    className="btn btn--primary"
                    disabled={!agreed || busy}
                    onClick={() => void run()}
                  >
                    {busy ? <Spinner size={12} label="Uploading" /> : null}
                    {busy ? 'Uploading…' : 'Upload to the blog'}
                  </button>
                </div>
              </section>
            )}
          </>
        )}

        {progress && (
          <section className="settings__section" aria-live="polite">
            <div className="settings__section-head">
              <h2 className="settings__h">{PHASE_LABEL[progress.phase]}</h2>
              <p className="settings__desc">
                {progress.imagesTotal > 0 &&
                  `${progress.imagesDone} of ${progress.imagesTotal} images · `}
                {progress.postsConfirmed} of {progress.postsTotal} posts on the blog
              </p>
            </div>
            <Progress
              value={
                progress.postsTotal === 0
                  ? 0
                  : (progress.postsConfirmed / progress.postsTotal) * 100
              }
              label="Upload progress"
            />
          </section>
        )}

        {failure && (
          <p className="notice notice--danger" role="alert">
            {failure}
          </p>
        )}

        {report && <Result report={report} />}

        {retirable && (
          <section className="settings__section">
            <div className="settings__section-head">
              <h2 className="settings__h">Remove the local copies</h2>
              <p className="settings__desc">
                Every post written on this device is now on the blog. You can remove the local
                copies to free up space. The posts themselves stay on the blog; only this
                browser's copy is deleted, and images that were never uploaded are kept.
              </p>
            </div>
            {retired ? (
              <p className="notice">
                Removed {retired.posts} local {retired.posts === 1 ? 'copy' : 'copies'} and{' '}
                {retired.images} {retired.images === 1 ? 'image' : 'images'}.
              </p>
            ) : (
              <div className="settings__footnote">
                <button className="btn btn--danger" onClick={() => void retire()}>
                  Remove local copies
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

const PHASE_LABEL: Record<MigrationProgress['phase'], string> = {
  preparing: 'Preparing images',
  uploading: 'Sending posts',
  confirming: 'Checking each post arrived',
  done: 'Finished',
};

/**
 * What happened, in the same order the writer will care about it: what landed,
 * what stopped it, and what could not go.
 */
function Result({ report }: { report: MigrationReport }) {
  const stopped = report.stoppedBy;
  return (
    <section className="settings__section" aria-live="polite">
      <div className="settings__section-head">
        <h2 className="settings__h">
          {report.confirmed.length} {report.confirmed.length === 1 ? 'post' : 'posts'} uploaded
        </h2>
        <p className="settings__desc">
          {report.images.uploaded} {report.images.uploaded === 1 ? 'image' : 'images'} uploaded
          {report.images.reused > 0 ? `, ${report.images.reused} already there` : ''}
          {report.images.missing > 0
            ? `. ${report.images.missing} ${report.images.missing === 1 ? 'image was' : 'images were'} referenced but no longer on this device, so those pictures were left as they are`
            : ''}
          .
        </p>
      </div>

      {stopped && (
        <p className="notice notice--warn" role="status">
          {stopped.reason === 'rate_limited'
            ? `The blog's hourly upload limit was reached, so the rest is still here. ${
                stopped.retryAfter
                  ? `Try again in about ${Math.ceil(stopped.retryAfter / 60)} minutes.`
                  : 'Try again later.'
              } Nothing already uploaded will be uploaded twice.`
            : stopped.reason === 'offline'
              ? 'The connection dropped part-way through, so the rest is still here. Try again when you are back online — nothing already uploaded will be uploaded twice.'
              : `The upload stopped: ${stopped.detail ?? 'an unexpected error'}. Nothing already uploaded will be uploaded twice.`}
        </p>
      )}

      {report.failed.length > 0 && (
        <div className="settings__rows">
          {report.failed.map((post) => (
            <div className="settings__row" key={post.id}>
              <div>
                <p className="settings__label">{post.title || 'Untitled'}</p>
                <p className="settings__hint">The blog refused this one: {post.detail}</p>
              </div>
              <span className="chip">not uploaded</span>
            </div>
          ))}
        </div>
      )}

      {report.revisionsNotCarried > 0 && (
        <p className="settings__footnote">
          {report.revisionsNotCarried} earlier{' '}
          {report.revisionsNotCarried === 1 ? 'snapshot' : 'snapshots'} of these posts stayed on this
          device, as described above.
        </p>
      )}
    </section>
  );
}

/**
 * The route form.
 *
 * `Migrate` takes its user as a PROP so its tests can drive it without a
 * session store, and so it cannot read an identity different from the one
 * `posts.ts` is writing under. This wrapper is the only place the two are
 * joined, and it renders nothing when there is no confirmed user: migration
 * publishes under the current account's name, so a screen that could run
 * against `unknown` or `offline` would be a screen that could publish under
 * nobody's.
 */
export default function MigrateRoute() {
  const session = useSession();
  if (session.status !== 'authed') return null;
  return <Migrate user={session.user} />;
}
