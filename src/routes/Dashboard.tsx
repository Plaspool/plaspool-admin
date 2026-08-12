import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
import { useSession } from '../components/RequireAuth';
import { useSidebarCounts } from '../components/Sidebar';
import { useCategories } from '../data/useCategories';
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

// ------------------------------------------------------- the filters, in the URL

/**
 * ALL FIVE FILTERS LIVE IN THE SEARCH PARAMS, AND THAT IS THE FIX FOR "BACK
 * FROM THE EDITOR LOSES MY TAB".
 *
 * They were five `useState`s. Opening a post unmounts this screen, so every
 * trip into the editor reset them to `all / '' / updated / null / null` — a
 * writer who had filtered to Published, searched for a name and sorted oldest
 * first lost all three by clicking one of the results, and got no hint that
 * they had.
 *
 * Nothing about the filtering itself moves: `filterAndSort`, the counts and the
 * category options below are the code they always were. Only the place the five
 * values are READ FROM changes, from component state to `?status=…&q=…`.
 *
 * `q` rather than `search` for the query, because this is a URL a writer may
 * end up pasting into a message and the short spelling is the conventional one.
 */
interface Filters {
  status: StatusFilter;
  search: string;
  sort: SortKey;
  category: string | null;
  tag: string | null;
}

const PARAM: Record<keyof Filters, string> = {
  status: 'status',
  search: 'q',
  sort: 'sort',
  category: 'category',
  tag: 'tag',
};

/**
 * What each filter means when its param is absent — and therefore the one value
 * that must never be WRITTEN. `/?status=all&sort=updated` and `/` are the same
 * screen, and the first is the one nobody wants in their address bar, in their
 * history or in a link they send someone. So `writeFilters` deletes a default
 * rather than setting it, and `/` stays clean.
 */
const DEFAULTS: Filters = {
  status: 'all',
  search: '',
  sort: 'updated',
  category: null,
  tag: null,
};

const TAB_KEYS = TABS.map((t) => t.key);
const SORT_KEYS = SORTS.map((s) => s.key);

/**
 * INVALID VALUES FALL BACK SILENTLY, on purpose. The only way to get
 * `?status=publised` into the bar is to type it or to follow a link somebody
 * typed, and answering that with an error screen would be the app making a
 * fuss about its own URL. The grid shows All, and the next click writes
 * something legal over it.
 */
function readFilters(params: URLSearchParams): Filters {
  const oneOf = <T extends string>(name: string, legal: T[], fallback: T): T => {
    const raw = params.get(name);
    return legal.includes(raw as T) ? (raw as T) : fallback;
  };
  return {
    status: oneOf(PARAM.status, TAB_KEYS, DEFAULTS.status),
    search: params.get(PARAM.search) ?? '',
    sort: oneOf(PARAM.sort, SORT_KEYS, DEFAULTS.sort),
    /*
     * `''` IS NOT A CATEGORY. `posts.category = ''` is what uncategorised means
     * on the server, this control has no way to ask for it, and `filterAndSort`
     * reads a falsy category as "no category filter" — so `?category=` is no
     * filter at all rather than a filter that matches nothing.
     */
    category: params.get(PARAM.category) || null,
    tag: params.get(PARAM.tag) || null,
  };
}

/** The same params with `patch` applied, defaults dropped rather than written. */
function writeFilters(base: URLSearchParams, patch: Partial<Filters>): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of Object.keys(patch) as (keyof Filters)[]) {
    const value = patch[key];
    if (value == null || value === '' || value === DEFAULTS[key]) next.delete(PARAM[key]);
    else next.set(PARAM[key], value);
  }
  return next;
}

// ------------------------------------------------------------------ scroll

/**
 * SCROLL POSITION, KEPT LOCALLY AND DELIBERATELY SO.
 *
 * The data router ships `<ScrollRestoration>` and it is the stock answer, but it
 * mounts inside the router in `src/main.tsx`, which another workstream owns this
 * run — so the same job is done here, for this one screen. If `main.tsx` ever
 * grows a `<ScrollRestoration>`, delete this map and the two effects that use
 * it; two mechanisms fighting over the same scroll offset is worse than
 * neither.
 *
 * Keyed by `location.key` rather than by the URL: two visits to
 * `/?status=draft` are two entries in the history stack, and the offset a
 * writer left on the second is not the offset they left on the first. The map
 * is module-scoped so it outlives the unmount that opening a post causes, and
 * capped so a long session cannot grow it without bound.
 */
const SCROLL_BY_ENTRY = new Map<string, number>();
const SCROLL_ENTRIES_KEPT = 30;

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
 *
 * The timer now guards the URL rather than the fetch — the box types into local
 * state and this is how long it waits before writing `?q=`, after which the
 * search fires off the param. Same 250 ms, one fewer place for the two to
 * disagree, and an abandoned prefix reaches neither the network nor the address
 * bar.
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

  const [params, setParams] = useSearchParams();
  const { status, search, sort, category, tag } = readFilters(params);

  /**
   * Every filter write that is not a tab, and every one of them REPLACES.
   *
   * A writer who narrows by category and then by tag wants Back to leave the
   * dashboard, not to unwind four filter changes one click at a time — and the
   * search box would otherwise put one history entry in per pause. Tabs are the
   * exception, and they are `<Link>`s below precisely so they push.
   */
  const setFilters = useCallback(
    (patch: Partial<Filters>) => {
      setParams((prev) => writeFilters(prev, patch), { replace: true });
    },
    [setParams],
  );

  /**
   * The box types into local state; a timer copies it into `?q=`.
   *
   * Both halves are load-bearing. Writing the param on every keystroke would
   * re-render the grid five times for the word "hello" and leave five entries
   * behind under any router that did not replace; holding the query only in
   * state is the bug this whole change exists to undo. So the param is the
   * truth and `draft` is the 250 ms of typing that has not reached it yet.
   */
  const [draft, setDraft] = useState(search);
  /**
   * The last value this box itself put in the URL. Without it the adopting
   * effect below cannot tell "`?q=` moved under us — Back, or a hand-edited
   * address" from "our own timer just fired", and adopting our own write would
   * clobber whatever was typed during the 250 ms it was in flight.
   */
  const pushedSearch = useRef(search);

  useEffect(() => {
    if (search === pushedSearch.current) return;
    pushedSearch.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === pushedSearch.current) return;
    const timer = window.setTimeout(() => {
      pushedSearch.current = draft;
      setFilters({ search: draft });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, setFilters]);

  /** Typing waits for the timer. A button that empties the box does not. */
  const clearSearch = useCallback(() => {
    pushedSearch.current = '';
    setDraft('');
    setFilters({ search: '' });
  }, [setFilters]);

  /** Search, category and tag dropped in ONE navigation rather than three. */
  const clearFilters = useCallback(() => {
    pushedSearch.current = '';
    setDraft('');
    setFilters({ search: '', category: null, tag: null });
  }, [setFilters]);

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

  /*
   * NO TIMER HERE ANY MORE — the debounce moved up to the box, which now writes
   * `?q=` on the pause rather than on the keystroke. A second 250 ms wait on
   * this side would have made every search half a second late for no gain, and
   * would have been a second place for the two intervals to drift apart.
   */
  useEffect(() => {
    const query = search.trim();
    if (!query || !userId) {
      setSearchIds(null);
      setSearchState('idle');
      return;
    }
    let alive = true;
    setSearchState('running');
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
    return () => {
      alive = false;
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
   * UP TO THE RAIL, which draws these five as its Posts pages now. Only this
   * screen can produce them — they are derived from the Dexie cache of every
   * post, narrowed by the active category and tag so the rail can never
   * advertise 7 next to a grid showing 2 — and `useSidebarCounts` clears them
   * on unmount so "Drafts 8" cannot follow you into the shop.
   */
  useSidebarCounts(counts);

  /*
   * FROM THE BLOG, NOT FROM THIS DEVICE'S CACHE (HANDOFF §4 C3).
   *
   * This was `[...new Set(all.map(p => p.category))]` — the categories on the
   * rows this browser happened to be holding — which meant the filter offered a
   * different set of categories on a machine that had synced a different slice
   * of the library, and could not offer one at all until something had been
   * cached. `GET /api/categories` answers with the managed list UNIONed with
   * every value actually in use, drafts included, so the list is the same on
   * every device and the same one the editor's Details panel picks from.
   *
   * `useCategories` keeps the old derivation as its fallback for the case where
   * that route does not answer, so an offline boot still gets its filter.
   *
   * Deliberately NOT scoped by the search, then or now. The dropdown lists
   * which categories EXIST; its numbers say how many posts each would return
   * under the current query. Scoping the list too would make categories vanish
   * and reappear as a writer types, which reads as the control breaking.
   */
  const { names: categories } = useCategories(userId);

  // Each option carries the number of posts it would actually return, scoped by
  // every filter except the category itself — a count that moved as soon as you
  // picked a category would be answering a different question. "All categories"
  // is the same query with the category dropped, so its number is exactly what
  // the grid shows when it is chosen.
  //
  // COUNTED HERE RATHER THAN TAKEN FROM `CategorySummary.count`, even though
  // the route now sends one. The server's number is the whole blog; this one is
  // what this grid would show under the tag, the status and the search that are
  // active right now, and those are different questions. A managed category
  // with nothing under the current filters therefore reads `(0)`, which is the
  // true answer to the question the dropdown is asking.
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
    //
    // Moving the list to the server made this arm MORE load-bearing, not less:
    // `?category=…` can now be a value typed into the address bar, or one the
    // route has simply not answered with yet, and both land here.
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

  /*
   * `draft`, not `search`: what a writer has typed counts as an active filter
   * from the keystroke, not from 250 ms later. Reading the param here would
   * leave the empty state offering "start something new" for a quarter of a
   * second after someone typed a query, which reads as the box being ignored.
   */
  const filtersActive = draft.trim() !== '' || category !== null || tag !== null;
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

  /**
   * THE TAB IN THE WINDOW TITLE.
   *
   * Two dashboards open — Drafts in one browser tab, Published in another — are
   * now two different URLs, so they can be two different titles instead of two
   * identical ones. `syncDocumentBrand` owns the title everywhere else and its
   * exact wording lives in `brand.ts`; the All tab therefore sets nothing at all
   * and the cleanup restores whatever was there, rather than this file
   * reconstructing that string and drifting from it.
   */
  useEffect(() => {
    if (status === 'all') return;
    const previous = document.title;
    document.title = `${TABS.find((t) => t.key === status)?.label ?? ''} · ${brand.name}`;
    return () => {
      document.title = previous;
    };
  }, [status]);

  /** The history entry this screen's scroll offset is filed under. */
  const entryKey = useLocation().key;
  const restoredEntry = useRef<string | null>(null);

  /*
   * Restore only once the grid exists. `window.scrollTo` against a document
   * that is still three skeletons tall does nothing at all, and the cache
   * normally answers a frame or two after mount — so this waits for `loading`
   * to clear and then fires once per history entry, which is what the ref
   * guards.
   */
  useEffect(() => {
    if (loading || restoredEntry.current === entryKey) return;
    restoredEntry.current = entryKey;
    const saved = SCROLL_BY_ENTRY.get(entryKey);
    if (saved) window.scrollTo(0, saved);
  }, [loading, entryKey]);

  useEffect(() => {
    const save = () => {
      // Delete-then-set so the key moves to the end of the insertion order,
      // which is what makes dropping the FIRST key drop the least recently
      // used entry rather than an arbitrary one.
      SCROLL_BY_ENTRY.delete(entryKey);
      SCROLL_BY_ENTRY.set(entryKey, window.scrollY);
      while (SCROLL_BY_ENTRY.size > SCROLL_ENTRIES_KEPT) {
        const oldest = SCROLL_BY_ENTRY.keys().next().value;
        if (oldest === undefined) break;
        SCROLL_BY_ENTRY.delete(oldest);
      }
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [entryKey]);

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
              {/*
                SIGN OUT USED TO BE HERE AND HAS MOVED TO THE SIDEBAR FOOTER,
                next to the identity it signs out. It was in this menu because
                for a while this menu was the only chrome the app had; now that
                there is a shell, a control that appears on one route and
                nowhere else is a control a writer cannot find from the editor
                or from Settings. Two copies would be worse than either: the
                unsent-work confirmation lives in `SignOutButton`, and two
                buttons asking that question are two chances to answer it
                wrongly. `Sidebar.tsx` renders the one that remains.
              */}
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
        {/*
          THE STATUS FILTERS LIVE IN THE SIDEBAR NOW.

          This row and the shop's and the email screens' were three copies of
          the same idea, each spending a line of the page on navigation directly
          above a heading that named the same thing. The rail shows the pages of
          whichever section you are in, so there is one navigation instead of
          two — and on a 375px screen that is a whole row of content back.

          Everything about the filtering is unchanged: the five links still
          write `?status=`, still push so Back walks Published to Drafts, and
          are still real links so ⌘-click opens a new tab. Only where they are
          drawn moved. The counts are handed up rather than recomputed, because
          they come from the Dexie cache of every post and the rail has no
          business reading that.
        */}

        <div className="dash__tools">
          <div className="searchbox">
            <Search className="ui-ic" aria-hidden="true" />
            <input
              className="searchbox__input"
              type="search"
              value={draft}
              /* The placeholder is where the change gets stated. Search is a
                 `tsvector` match now, so "whole words" is the one-line version
                 of the two regressions the empty state spells out. */
              placeholder="Search whole words in titles, tags and text…"
              aria-label="Search posts"
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft && (
              <button
                className="searchbox__clear"
                onClick={clearSearch}
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
              onChange={(v) => setFilters({ category: fromSelectValue(v) })}
              options={categoryOptions}
            />
          )}

          <Select<SortKey>
            label="Sort posts"
            value={sort}
            onChange={(v) => setFilters({ sort: v })}
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
          />
        </div>
      </div>

      {/* Reads `?tag=`, and clearing it drops the param — so the chip and the
          URL can never disagree about what the grid is showing. */}
      {tag && (
        <div className="dash__activefilter">
          Tagged <strong>{tag}</strong>
          <button onClick={() => setFilters({ tag: null })} aria-label="Clear tag filter">
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
            searching={draft.trim() !== ''}
            searchState={searchState}
            localOnly={localOnly}
            canWrite={online}
            onNew={newPost}
            onClear={clearFilters}
          />
        ) : (
          visible.map((p, i) => (
            <PostCard
              // Keyed on the filter too, so changing view replays the stagger
              // instead of silently swapping content in place.
              key={`${status}:${sort}:${p.id}`}
              index={i}
              post={p}
              onTag={(t) => setFilters({ tag: t })}
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
