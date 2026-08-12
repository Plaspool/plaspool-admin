import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Download,
  HardDrive,
  Keyboard,
  MoreHorizontal,
  Plus,
  Search,
  Settings as SettingsIcon,
  Upload,
  X,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../data/api';
import { cacheList, cachedList } from '../data/cache';
import { checkStorage, db, type StorageStatus } from '../data/db';
import { countPending } from '../data/pending';
import { whenReplayed } from '../data/session';
import { syncList } from '../data/sync';
import { surveyLocalPosts, type MigrationReport } from '../data/migrate';
import {
  ImportError,
  downloadJSONBundle,
  downloadLocalBundle,
  importBundle,
  type ExportProgress,
} from '../data/backup';
import { ThemeToggle } from '../components/ThemeToggle';
import { OfflineBanner, useOnline } from '../components/OfflineBanner';
import { SignOutButton, useSession } from '../components/RequireAuth';
import {
  createPost,
  destroyPost,
  duplicatePost,
  emptyTrash,
  filterAndSort,
  restorePost,
  trashPost,
  unpublishPost,
  publishPost,
  sweepBlankDrafts,
  archivePost,
  unarchivePost,
  type SortKey,
  type StatusFilter,
} from '../data/posts';
import { PostCard } from '../components/PostCard';
import { Select } from '../components/ui/Select';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../components/ui/Menu';
import { Skeleton, ProgressIndeterminate } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { ConfirmDialog } from '../components/Dialog';
import { openShortcuts } from '../components/ShortcutsDialog';
import { BrandLogo } from '../components/BrandLogo';
import { brand } from '../brand';
import { useToast } from '../components/Toast';
import type { ListPost } from '../data/types';
import './dashboard.css';

const TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'published', label: 'Published' },
  { key: 'draft', label: 'Drafts' },
  { key: 'archived', label: 'Archived' },
  { key: 'trash', label: 'Trash' },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Recently updated' },
  { key: 'published', label: 'Recently published' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'alphabetical', label: 'A–Z' },
  { key: 'drafts-first', label: 'Drafts first' },
];

/**
 * Radix throws outright on a Select item with `value=""`, so "no category
 * filter" needs a sentinel rather than the empty string. Both directions of the
 * mapping live here so they cannot drift apart, and `Query.category` stays
 * `string | null` everywhere outside this control.
 */
const ALL_CATEGORIES = '__all__';
const fromSelectValue = (v: string): string | null =>
  v === ALL_CATEGORIES ? null : v;
const toSelectValue = (c: string | null): string => c ?? ALL_CATEGORIES;

// ------------------------------------------------------------------ search

/**
 * SEARCH GOES TO THE SERVER, AND THAT IS NOT AN OPTIMISATION (plan §5, F6).
 *
 * `db.postList` holds whatever the last `syncList` cached, which is normally
 * everything — but "normally" is the problem. Searching the cache means the
 * same query returns different answers depending on which pages happened to
 * land, and it means agreeing with the blog only by coincidence:
 * `server/repo/query.ts` matches a `tsvector`, `filterAndSort` lowercases a
 * joined string and calls `includes`. Those are different functions. `bodies`
 * finds `body` on one side and not the other.
 *
 * So a non-empty query is answered by `GET /posts?search=…`, the rows are
 * cached, and the ids are held in a set. Everything downstream then filters by
 * that set and passes `search: ''` into `filterAndSort`, which leaves every
 * existing count, category option, tag filter and sort computing exactly what
 * it computed before.
 */
const SEARCH_VIEWS: StatusFilter[] = ['all', 'trash'];
const SEARCH_PAGE_LIMIT = 100;
const SEARCH_MAX_PAGES = 200;

/**
 * One request per keystroke would be one request per keystroke. 250 ms is
 * below the point a typist notices and above the gap between characters, and
 * the effect's cleanup cancels the timer, so an abandoned prefix never reaches
 * the network at all.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Both status views, for the same reason `syncList` walks both: the server
 * pushes `deleted_at IS NULL` for every status except `trash`, so a single
 * pass would make the Trash tab's count permanently 0 for any search.
 */
async function searchServer(userId: string, search: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const status of SEARCH_VIEWS) {
    let cursor: string | undefined;
    for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
      const res = await api.listPosts({ search, status, cursor, limit: SEARCH_PAGE_LIMIT });
      // Cached as they arrive: a match for a post this device has never seen
      // has to become a card, and the card is rendered from `db.postList`.
      await cacheList(userId, res.items);
      for (const item of res.items) ids.add(item.id);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  }
  return ids;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const session = useSession();
  const online = useOnline();

  /**
   * `unknown` cannot reach here — `RequireAuth` renders nothing until the
   * session resolves — but `offline` can, and it carries this device's last
   * confirmed user. That id is what scopes every read below (I2).
   */
  const user = session.status === 'unknown' ? null : session.user;
  const userId = user?.id ?? '';

  /**
   * OWNER-ONLY ROUTES DECIDE WHAT IS RENDERED, not what happens when it is
   * clicked. `DELETE /api/posts/:id` and `POST /api/trash/empty` are both
   * `requireOwner()` (`server/authorize.ts:48`), so for a writer those two
   * controls are a 403 with a confirmation dialog in front of it — the app
   * asking "are you sure?" about something it is not allowed to do.
   */
  const isOwner = user?.role === 'owner';

  /**
   * `db.postList`, NOT `db.posts` (plan §2.1, §4).
   *
   * After the cutover `db.posts` holds only the posts whose bodies have been
   * fetched — the ones the writer has opened — because a list response has no
   * `content` and may never reach the store the frozen editor hydrates from.
   * Reading it here would render a grid of two cards over a library of two
   * hundred.
   */
  const posts = useLiveQuery(() => cachedList(userId), [userId]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  /** Which long-running library action is in flight, if any. */
  const [busy, setBusy] = useState<'import' | 'export' | 'local-export' | null>(null);
  const [exported, setExported] = useState<ExportProgress | null>(null);
  const [imported, setImported] = useState<MigrationReport | null>(null);

  useEffect(() => {
    void checkStorage().then(setStorage);
  }, []);

  /**
   * THE BLANK-DRAFT SWEEP RUNS ONLY AFTER A CLEAN REPLAY, and ordering it
   * after `replayPending` is not the same thing (plan §4).
   *
   * `POST /api/posts/sweep-blank` hard-deletes, writer-scoped, every draft that
   * is blank ON THE SERVER and past the 60 s grace. A post created online and
   * then written into entirely offline is exactly that: the server still holds
   * the empty row it issued, and every word the writer typed is in a `pending`
   * patch that has not landed. If replay failed — an otherwise-online boot
   * where one request 5xx'd — the sweep would destroy the row those words are
   * waiting to be applied to, and `savePost` would then 404 forever.
   *
   * So the test is not "did replay finish" but "is anything still unsent", and
   * any pending row for this user skips the sweep entirely. The cost of
   * skipping is one Untitled card until the next clean boot.
   */
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    void (async () => {
      await whenReplayed();
      if (!alive) return;
      if ((await countPending(userId)) > 0) return;
      await sweepBlankDrafts().catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  /**
   * HAS THE LIST BEEN FETCHED YET (plan §5).
   *
   * `db.postList` answers `[]` in a millisecond, long before the first page
   * comes back, so without this flag the "A blank page, on purpose" empty state
   * paints over a library that is on its way — the single most alarming thing
   * this screen can show someone who has two hundred posts.
   *
   * The cheap arm first: rows already cached for this user prove that a walk
   * finished at some point, so nothing is loading and no request is needed.
   * That is also what keeps this from duplicating `AppShell`'s revalidation of
   * `/` on every visit — the walk below runs only on the boot where the cache
   * cannot answer, which is the one case the flag exists for.
   */
  const [listSynced, setListSynced] = useState(false);
  useEffect(() => {
    if (!userId) {
      setListSynced(true);
      return;
    }
    let alive = true;
    void (async () => {
      if ((await db.postList.where('ownerUserId').equals(userId).count()) > 0) {
        if (alive) setListSynced(true);
        return;
      }
      // Swallowed: offline is not an error here, it is an empty cache and a
      // banner. `syncList` has already written whatever pages it did get.
      await syncList(userId).catch(() => {});
      if (alive) setListSynced(true);
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [category, setCategory] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'destroy'; post: ListPost }
    | { kind: 'empty-trash'; count: number }
    | null
  >(null);

  /**
   * `null` means "no search is active", which is different from "a search
   * matched nothing" — the empty set. Collapsing them would make an unmatched
   * query show the whole library.
   */
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'running' | 'failed'>('idle');

  useEffect(() => {
    const query = search.trim();
    if (!query || !userId) {
      setSearchIds(null);
      setSearchState('idle');
      return;
    }
    let alive = true;
    setSearchState('running');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const ids = await searchServer(userId, query);
          if (!alive) return;
          setSearchIds(ids);
          setSearchState('idle');
        } catch {
          if (!alive) return;
          /*
           * An empty set AND a `failed` flag. The set is what stops stale
           * results from a previous query being shown as if they answered this
           * one; the flag is what stops the grid saying "nothing matches",
           * which would be a claim about the library rather than about the
           * connection.
           */
          setSearchIds(new Set());
          setSearchState('failed');
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search, userId]);

  /** The pre-backend corpus, and whether any of it is still only here. */
  const [localOnly, setLocalOnly] = useState(0);
  const refreshLocal = () => {
    void surveyLocalPosts()
      .then((s) => setLocalOnly(s.pending.length + s.excluded.length))
      .catch(() => setLocalOnly(0));
  };
  useEffect(refreshLocal, []);

  const all = posts ?? [];

  /**
   * The rows a server search left standing. Every derivation below works from
   * this instead of `all`, and passes `search: ''` to `filterAndSort` — so the
   * counts, options and orderings are the code they always were, applied to a
   * smaller set.
   */
  const scoped = useMemo(
    () => (searchIds === null ? all : all.filter((p) => searchIds.has(p.id))),
    [all, searchIds],
  );

  // Counts reflect the active search and filters, so the tabs can never
  // advertise 7 posts next to a grid showing 2.
  const counts = useMemo(() => {
    const live = filterAndSort(scoped, {
      status: 'all',
      search: '',
      category,
      tag,
      sort: 'updated',
    });
    const trashScoped = filterAndSort(scoped, {
      status: 'trash',
      search: '',
      category,
      tag,
      sort: 'updated',
    });
    return {
      all: live.length,
      published: live.filter((p) => p.status === 'published').length,
      draft: live.filter((p) => p.status === 'draft').length,
      archived: live.filter((p) => p.status === 'archived').length,
      trash: trashScoped.length,
    } as Record<StatusFilter, number>;
  }, [scoped, category, tag]);

  /*
   * Deliberately from `all` rather than from `scoped`. The dropdown lists which
   * categories EXIST; its numbers say how many posts each would return under
   * the current query. That is what it did before search moved to the server,
   * and scoping the list too would make categories vanish and reappear as a
   * writer types, which reads as the control breaking.
   */
  const categories = useMemo(
    () =>
      [...new Set(all.filter((p) => p.deletedAt == null).map((p) => p.category))]
        .filter(Boolean)
        .sort(),
    [all],
  );

  // Each option carries the number of posts it would actually return, scoped by
  // every filter except the category itself — a count that moved as soon as you
  // picked a category would be answering a different question. "All categories"
  // is the same query with the category dropped, so its number is exactly what
  // the grid shows when it is chosen.
  const categoryOptions = useMemo(() => {
    const withoutCategory = filterAndSort(scoped, {
      status,
      search: '',
      category: null,
      tag,
      sort: 'updated',
    });
    // The selected category is pinned into the list even when nothing carries
    // it any more — trash the last post in a category, or rename it in the
    // editor, and `categories` drops it while the filter is still applied.
    // Radix then renders a trigger with no matching item: a blank control above
    // an empty grid, which reads as broken rather than as "0 results".
    const listed =
      category && !categories.includes(category)
        ? [...categories, category].sort()
        : categories;
    return [
      { value: ALL_CATEGORIES, label: `All categories (${withoutCategory.length})` },
      ...listed.map((c) => ({
        value: c,
        label: `${c} (${withoutCategory.filter((p) => p.category === c).length})`,
      })),
    ];
  }, [scoped, categories, category, status, tag]);

  const visible = useMemo(
    () => filterAndSort(scoped, { status, search: '', category, tag, sort }),
    [scoped, status, category, tag, sort],
  );

  const totalWords = useMemo(
    () =>
      all
        .filter((p) => p.deletedAt == null)
        .reduce((sum, p) => sum + p.wordCount, 0),
    [all],
  );

  async function newPost() {
    try {
      const post = await createPost();
      navigate(`/edit/${post.id}`);
    } catch {
      /*
       * `POST /posts` has no pending path — a patch is keyed by a post id and
       * a post the server has never issued has none — so this is one of the
       * two things that genuinely cannot happen offline (plan §7). Saying so
       * beats an unhandled rejection and a button that does nothing.
       */
      notify(
        online
          ? 'That post couldn’t be started. Try again in a moment.'
          : 'A new post needs the connection. Anything already open keeps saving.',
        { tone: 'danger' },
      );
    }
  }

  const filtersActive = search.trim() !== '' || category !== null || tag !== null;
  /** The store answered AND the first list walk finished. Both, or skeletons. */
  const loading = posts === undefined || !listSynced;
  const showSkeletons = useDelayed(loading, 220);

  // If the store never answers, stop pretending we are loading. Skeletons
  // forever, next to a masthead reading "0 posts", is the worst of both.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!loading) {
      setStalled(false);
      return;
    }
    const t = window.setTimeout(() => setStalled(true), 5000);
    return () => window.clearTimeout(t);
  }, [loading]);

  return (
    <div className="dash">
      <header className="dash__masthead">
        <div className="dash__brand">
          <div>
            {/* The <h1> is the logo. Its accessible name comes from the image's
                own `alt`, so a screen reader hears the publication once — not
                once for the artwork and again for a hidden label. */}
            <h1 className="dash__title">
              <BrandLogo className="dash__logo" />
            </h1>
            <p className="dash__sub">
              {loading
                ? 'Opening your library…'
                : /*
                   * "stored on this device" WAS TRUE AND IS NOT ANY MORE. The
                   * posts are on the blog; this browser holds a copy so the
                   * app keeps working without a connection. Saying the old
                   * sentence now would tell a writer their words are somewhere
                   * they are not, which is the sentence that stops people
                   * making backups.
                   */
                  `${counts.all} ${counts.all === 1 ? 'post' : 'posts'} · ${totalWords.toLocaleString()} words written · ${
                    online ? 'saved to the blog' : 'showing this device’s copy'
                  }`}
            </p>
          </div>
        </div>
        <div className="dash__masthead-actions">
          <ThemeToggle />
          <Link
            className="btn btn--ghost btn--sm"
            to="/settings"
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon className="ui-ic" aria-hidden="true" />
          </Link>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file || !userId) return;
              setBusy('import');
              setImported(null);
              try {
                /*
                 * Through `migrate.ts`'s pipeline, never `bulkAdd`. An import
                 * that wrote into the cache would produce rows with no owner
                 * and no server copy — invisible in this grid and deleted by
                 * the next `clearCache`, under a toast claiming success.
                 */
                const report = await importBundle(userId, await file.text());
                setImported(report);
                const n = report.confirmed.length;
                notify(
                  `Added ${n} ${n === 1 ? 'post' : 'posts'} to the blog`,
                  n === 0 ? { tone: 'danger' } : undefined,
                );
              } catch (err) {
                notify(
                  err instanceof ImportError ? err.message : 'That file couldn’t be imported.',
                  { tone: 'danger' },
                );
              } finally {
                setBusy(null);
              }
            }}
          />
          <Menu>
            <MenuTrigger asChild>
              <button className="btn btn--ghost btn--sm" aria-label="Library actions">
                <MoreHorizontal className="ui-ic" aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                icon={<Upload className="ui-ic" />}
                disabled={!online}
                onSelect={() => importInput.current?.click()}
              >
                Import a backup
              </MenuItem>
              <MenuItem
                icon={<Download className="ui-ic" />}
                disabled={all.length === 0 || !user || !online}
                onSelect={async () => {
                  if (!user) return;
                  setBusy('export');
                  setExported(null);
                  try {
                    /*
                     * An owner gets `GET /api/export` in one request; a writer
                     * gets the same bundle rebuilt from routes they already
                     * have. The progress bar exists because of the second
                     * case: it is one request per post plus one per revision,
                     * and an unexplained two-minute pause reads as a hang.
                     */
                    const n = await downloadJSONBundle(user, setExported);
                    notify(`Exported ${n} ${n === 1 ? 'post' : 'posts'} with their history`);
                  } catch {
                    notify('The export couldn’t be finished.', { tone: 'danger' });
                  } finally {
                    setBusy(null);
                    setExported(null);
                  }
                }}
              >
                Export everything
              </MenuItem>
              <MenuSeparator />
              {/* A shortcut nobody can find is a shortcut nobody has. */}
              <MenuItem icon={<Keyboard className="ui-ic" />} onSelect={openShortcuts}>
                Keyboard shortcuts
              </MenuItem>
              <MenuItem icon={<SettingsIcon className="ui-ic" />} onSelect={() => navigate('/settings')}>
                Settings
              </MenuItem>
              <MenuSeparator />
              {/*
                THE ONLY WAY OUT OF THE APP. `SignOutButton` existed only inside
                the re-auth prompt, which a signed-in writer never sees — so
                until now the app had no sign-out at all, which on a shared
                machine is the whole of its access control. The component is
                reused rather than reimplemented because it owns the
                unsent-work confirmation: `session.logout()` refuses to proceed
                without `confirmed`, and this is the button that asks.
              */}
              <SignOutButton className="ui-menu__item ui-menu__item--danger" label="Sign out" />
            </MenuContent>
          </Menu>
          <button
            className="btn btn--primary"
            onClick={newPost}
            disabled={!online}
            title={online ? undefined : 'Starting a new post needs the connection'}
          >
            <Plus className="ui-ic" aria-hidden="true" />
            New post
          </button>
        </div>
      </header>

      <OfflineBanner />

      {busy && (
        <div className="dash__busy" role="status">
          <ProgressIndeterminate
            label={
              busy === 'import'
                ? 'Importing backup'
                : busy === 'local-export'
                  ? 'Saving this device’s posts'
                  : 'Preparing export'
            }
          />
          <span>
            {busy === 'import'
              ? 'Uploading your backup to the blog…'
              : busy === 'local-export'
                ? 'Saving the posts that are only on this device…'
                : exported && exported.total > 0
                  ? `Collecting post ${exported.posts} of ${exported.total}…`
                  : 'Preparing your export…'}
          </span>
        </div>
      )}

      {/*
        WHAT DID NOT GO IN, NAMED. An import that reports only its successes is
        the shape of defect this project's own log keeps recording: "Imported 12
        posts" over a bundle of 14 is a true sentence that hides the question
        the writer actually has.
      */}
      {imported &&
        (imported.excluded.length > 0 ||
          imported.failed.length > 0 ||
          imported.stoppedBy !== null) && (
          <div className="notice notice--warn" role="status">
            <div>
              <strong>Some of that backup did not go up.</strong>{' '}
              {imported.excluded.length > 0 &&
                `${imported.excluded.length} ${imported.excluded.length === 1 ? 'post' : 'posts'} the blog will not accept. `}
              {imported.failed.length > 0 &&
                `${imported.failed.length} ${imported.failed.length === 1 ? 'was' : 'were'} refused. `}
              {imported.stoppedBy?.reason === 'rate_limited'
                ? 'The blog’s hourly upload limit was reached — import the same file again later and nothing already uploaded goes up twice.'
                : imported.stoppedBy?.reason === 'offline'
                  ? 'The connection dropped part-way through — import the same file again and nothing already uploaded goes up twice.'
                  : ''}
            </div>
            <div className="notice__actions">
              <button className="btn btn--ghost btn--sm" onClick={() => setImported(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}

      {/*
        THE PRE-BACKEND LIBRARY, WHICH NOTHING ELSE ON THIS SCREEN CAN SHOW.
        Those posts moved out of `db.posts` into `localPosts` at the v1→v2
        upgrade, so they are not in the grid, are not on the blog, and are in
        nobody's backup. Without this band a writer who upgraded finds their
        whole library apparently gone.
      */}
      {localOnly > 0 && (
        <div className="notice" role="status">
          <div>
            <HardDrive className="ui-ic" aria-hidden="true" />{' '}
            <strong>
              {localOnly} {localOnly === 1 ? 'post is' : 'posts are'} still only on this device.
            </strong>{' '}
            {localOnly === 1 ? 'It was' : 'They were'} written here before this browser was
            connected to the blog, so {localOnly === 1 ? 'it is' : 'they are'} not on the blog
            and not in any backup it holds.
          </div>
          <div className="notice__actions">
            <Link className="btn btn--outline btn--sm" to="/migrate">
              Move to the blog
            </Link>
            <button
              className="btn btn--ghost btn--sm"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('local-export');
                try {
                  const n = await downloadLocalBundle();
                  notify(`Saved ${n} ${n === 1 ? 'post' : 'posts'} from this device`);
                } catch {
                  notify('Those posts couldn’t be saved to a file.', { tone: 'danger' });
                } finally {
                  setBusy(null);
                }
              }}
            >
              Save a copy
            </button>
          </div>
        </div>
      )}

      {stalled && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>Your library isn’t opening.</strong> This usually means
            another tab of {brand.name} is holding the database open. Your posts
            are still on disk — close the other tabs and reload.
          </div>
          <div className="notice__actions">
            <button
              className="btn btn--outline btn--sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )}

      {storage && !storage.ok && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>
              {storage.reason === 'full'
                ? 'This browser’s storage is nearly full.'
                : storage.reason === 'blocked'
                  ? 'Another tab is holding an older version of the database.'
                  : 'This browser won’t let the app store data.'}
            </strong>{' '}
            {storage.reason === 'blocked'
              ? 'Close the other tabs of this app and reload.'
              : 'New writing may not be saved. Export what you have before continuing.'}
          </div>
          <div className="notice__actions">
            <button
              className="btn btn--outline btn--sm"
              disabled={!user || !online}
              onClick={() => user && void downloadJSONBundle(user)}
            >
              Export now
            </button>
          </div>
        </div>
      )}

      <div className="dash__controls">
        <nav className="tabs" aria-label="Filter by status">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tabs__tab${status === t.key ? ' is-active' : ''}`}
              onClick={() => setStatus(t.key)}
              aria-current={status === t.key}
            >
              {t.label}
              <span className="tabs__count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="dash__tools">
          <div className="searchbox">
            <Search className="ui-ic" aria-hidden="true" />
            <input
              className="searchbox__input"
              type="search"
              value={search}
              /* The placeholder is where the change gets stated. Search is a
                 `tsvector` match now, so "whole words" is the one-line version
                 of the two regressions the empty state spells out. */
              placeholder="Search whole words in titles, tags and text…"
              aria-label="Search posts"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                className="searchbox__clear"
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                <X className="ui-ic" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Single-select, deliberately. `Query.category` is `string | null`,
              `filterAndSort` matches one category, and a post has exactly one
              `category`. Multi-membership is what `tags` are for, and tags
              already have their own filter interaction. */}
          {(categories.length > 0 || category !== null) && (
            <Select<string>
              label="Filter by category"
              value={toSelectValue(category)}
              onChange={(v) => setCategory(fromSelectValue(v))}
              options={categoryOptions}
            />
          )}

          <Select<SortKey>
            label="Sort posts"
            value={sort}
            onChange={setSort}
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
          />
        </div>
      </div>

      {tag && (
        <div className="dash__activefilter">
          Tagged <strong>{tag}</strong>
          <button onClick={() => setTag(null)} aria-label="Clear tag filter">
            ×
          </button>
        </div>
      )}

      {status === 'trash' && counts.trash > 0 && (
        <div className="trashbar">
          <span>
            Posts in trash keep their full history. Nothing here is gone until you
            say so.
            {/* The absence of the button is explained rather than left as a
                gap. `POST /api/trash/empty` is `requireOwner()`, and the trash
                it empties belongs to every writer on the blog. */}
            {!isOwner && ' Only the blog owner can empty it.'}
          </span>
          {isOwner && (
            <button
              className="btn btn--danger btn--sm"
              onClick={() => setConfirm({ kind: 'empty-trash', count: counts.trash })}
            >
              Empty trash
            </button>
          )}
        </div>
      )}

      <main className="dash__grid">
        {loading ? (
          // Held back 220ms: the cache normally answers faster than a person
          // can perceive, and a skeleton that flashes reads as a fault.
          showSkeletons
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="card card--skeleton" aria-hidden="true">
                  <Skeleton height={170} radius="0" />
                  <Skeleton height={22} width="70%" />
                  <Skeleton height={14} width="90%" />
                  <Skeleton height={14} width="55%" />
                </div>
              ))
            : null
        ) : visible.length === 0 ? (
          <EmptyState
            status={status}
            filtersActive={filtersActive}
            searching={search.trim() !== ''}
            searchState={searchState}
            localOnly={localOnly}
            canWrite={online}
            onNew={newPost}
            onClear={() => {
              setSearch('');
              setCategory(null);
              setTag(null);
            }}
          />
        ) : (
          visible.map((p, i) => (
            <PostCard
              // Keyed on the filter too, so changing view replays the stagger
              // instead of silently swapping content in place.
              key={`${status}:${sort}:${p.id}`}
              index={i}
              post={p}
              onTag={setTag}
              // `DELETE /api/posts/:id` is owner-only, so for a writer this
              // button is a confirmation dialog in front of a 403.
              canDestroy={isOwner}
              actions={{
                edit: () => navigate(`/edit/${p.id}`),
                read: () => navigate(`/read/${p.id}`),
                duplicate: async () => {
                  const copy = await duplicatePost(p.id);
                  notify('Duplicated as a new draft', {
                    action: { label: 'Open', run: () => navigate(`/edit/${copy.id}`) },
                  });
                },
                publish: async () => {
                  // Same guard the editor applies — the two surfaces must
                  // agree about what is publishable.
                  if (!p.title.trim() && p.wordCount === 0) {
                    notify('Add a title or some words before publishing', {
                      tone: 'danger',
                      action: { label: 'Open', run: () => navigate(`/edit/${p.id}`) },
                    });
                    return;
                  }
                  await publishPost(p.id);
                  notify('Published');
                },
                unpublish: async () => {
                  await unpublishPost(p.id);
                  notify('Moved back to drafts');
                },
                archive: async () => {
                  await archivePost(p.id);
                  notify('Archived', {
                    action: { label: 'Undo', run: () => void unarchivePost(p.id) },
                  });
                },
                unarchive: async () => {
                  await unarchivePost(p.id);
                  notify('Restored to drafts');
                },
                trash: async () => {
                  await trashPost(p.id);
                  notify('Moved to trash', {
                    action: { label: 'Undo', run: () => void restorePost(p.id) },
                  });
                },
                restore: async () => {
                  await restorePost(p.id);
                  notify('Restored');
                },
                destroy: () => setConfirm({ kind: 'destroy', post: p }),
              }}
            />
          ))
        )}
      </main>

      <ConfirmDialog
        open={confirm?.kind === 'destroy'}
        onClose={() => setConfirm(null)}
        title="Delete permanently?"
        description={
          confirm?.kind === 'destroy' ? (
            <>
              “{confirm.post.title || 'Untitled'}” and its{' '}
              {confirm.post.wordCount.toLocaleString()} words will be erased from the
              blog, along with their history. This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete forever"
        danger
        onConfirm={async () => {
          if (confirm?.kind !== 'destroy') return;
          await destroyPost(confirm.post.id);
          notify('Permanently deleted', { tone: 'danger' });
        }}
      />

      <ConfirmDialog
        open={confirm?.kind === 'empty-trash'}
        onClose={() => setConfirm(null)}
        title="Empty the trash?"
        description={
          confirm?.kind === 'empty-trash'
            ? `${confirm.count} ${
                confirm.count === 1 ? 'post' : 'posts'
              } will be erased permanently, along with their revision history.`
            : null
        }
        confirmLabel="Empty trash"
        danger
        onConfirm={async () => {
          const n = await emptyTrash();
          notify(`Deleted ${n} ${n === 1 ? 'post' : 'posts'}`, { tone: 'danger' });
        }}
      />
    </div>
  );
}

function EmptyState({
  status,
  filtersActive,
  searching,
  searchState,
  localOnly,
  canWrite,
  onNew,
  onClear,
}: {
  status: StatusFilter;
  filtersActive: boolean;
  /** A non-empty query is active, so the answer came from the server. */
  searching: boolean;
  searchState: 'idle' | 'running' | 'failed';
  /** Un-migrated pre-backend posts, which are not in this grid at all. */
  localOnly: number;
  canWrite: boolean;
  onNew: () => void;
  onClear: () => void;
}) {
  if (searching && searchState === 'failed') {
    /*
     * NOT "nothing matches". The search never reached the blog, so the app
     * knows nothing about whether anything matched — and telling a writer their
     * post is gone when the answer is "we could not ask" is the same class of
     * lie as the deletion tombstone this cutover spends most of its care
     * avoiding.
     */
    return (
      <div className="empty">
        <h2 className="empty__title">Couldn’t search the blog</h2>
        <p className="empty__body">
          The search didn’t reach the blog, so there is nothing to show yet — not
          because nothing matched. Your posts are unaffected.
        </p>
        <button className="btn btn--outline" onClick={onClear}>
          Clear search
        </button>
      </div>
    );
  }

  if (filtersActive) {
    return (
      <div className="empty">
        <h2 className="empty__title">Nothing matches</h2>
        {searching ? (
          /*
           * The two regressions `server/repo/query.ts` documents in its own
           * head comment, said in the place a writer meets them. Search is a
           * `tsvector` match now: `ost` no longer finds `post`, and a query
           * made only of stopwords — `the`, `and` — returns zero rows however
           * many posts contain those letters. Both are correct behaviour and
           * both look like a bug from here unless the screen says so.
           */
          <p className="empty__body">
            Search matches whole words on the blog, so a part of a word like
            “ost” no longer finds “post”, and a search made only of very common
            words like “the” finds nothing at all.
          </p>
        ) : (
          <p className="empty__body">No posts fit the current filters.</p>
        )}
        <button className="btn btn--outline" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }

  const copy: Record<StatusFilter, { title: string; body: string }> = {
    all: {
      title: 'A blank page, on purpose',
      /*
       * "Everything you write lives in this browser — no account, no server,
       * no waiting" DESCRIBED THE APP BEFORE THIS CUTOVER AND NOW DESCRIBES
       * NONE OF IT. There is an account, there is a server, and the local copy
       * is what makes the waiting invisible rather than what replaces it.
       */
      body: 'Everything you write goes to the blog as you type, and stays on this device so you can keep writing when the connection drops.',
    },
    published: {
      title: 'Nothing published yet',
      body: 'Drafts become published posts the moment you hit Publish.',
    },
    draft: {
      title: 'No drafts open',
      body: 'Start something and it will autosave here as you type.',
    },
    archived: {
      title: 'No archived posts',
      body: 'Archiving keeps finished work out of the way without deleting it.',
    },
    trash: {
      title: 'Trash is empty',
      body: 'Deleted posts wait here until you clear them out.',
    },
  };
  const c = copy[status];

  /*
   * An un-migrated corpus makes "you have written nothing" false, so the
   * all-status empty state hands over to it rather than sitting above a banner
   * that contradicts it (plan §5).
   */
  const body =
    status === 'all' && localOnly > 0
      ? `Nothing is on the blog yet — but ${localOnly} ${localOnly === 1 ? 'post is' : 'posts are'} waiting on this device. Move ${localOnly === 1 ? 'it' : 'them'} up, or start something new.`
      : c.body;

  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <path d="M14 52V12a2 2 0 0 1 2-2h22l12 12v30a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2Z" />
          <path d="M38 10v12h12" />
          <path d="M22 32h20M22 40h14" />
        </svg>
      </div>
      <h2 className="empty__title">{c.title}</h2>
      <p className="empty__body">{body}</p>
      {status !== 'trash' && status !== 'archived' && (
        <button
          className="btn btn--primary"
          onClick={onNew}
          disabled={!canWrite}
          title={canWrite ? undefined : 'Starting a new post needs the connection'}
        >
          Write your first post
        </button>
      )}
    </div>
  );
}
