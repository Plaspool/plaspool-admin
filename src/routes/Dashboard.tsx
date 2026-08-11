import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Download,
  Keyboard,
  MoreHorizontal,
  Plus,
  Search,
  Settings as SettingsIcon,
  Upload,
  X,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { checkStorage, db, type StorageStatus } from '../data/db';
import { ImportError, downloadJSONBundle, importBundle } from '../data/backup';
import { ThemeToggle } from '../components/ThemeToggle';
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
import { useToast } from '../components/Toast';
import type { Post } from '../data/types';
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

export default function Dashboard() {
  const navigate = useNavigate();
  const { notify } = useToast();

  const posts = useLiveQuery(() => db.posts.toArray(), []);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  /** Which long-running library action is in flight, if any. */
  const [busy, setBusy] = useState<'import' | 'export' | null>(null);

  useEffect(() => {
    void checkStorage().then(setStorage);
    // Clear blank drafts abandoned via browser Back or a closed tab.
    void sweepBlankDrafts().catch(() => {});
  }, []);

  // If the store never answers, stop pretending we are loading. Skeletons
  // forever, next to a masthead reading "0 posts", is the worst of both.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (posts !== undefined) {
      setStalled(false);
      return;
    }
    const t = window.setTimeout(() => setStalled(true), 5000);
    return () => window.clearTimeout(t);
  }, [posts]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [category, setCategory] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'destroy'; post: Post }
    | { kind: 'empty-trash'; count: number }
    | null
  >(null);

  const all = posts ?? [];

  // Counts reflect the active search and filters, so the tabs can never
  // advertise 7 posts next to a grid showing 2.
  const counts = useMemo(() => {
    const scoped = filterAndSort(all, {
      status: 'all',
      search,
      category,
      tag,
      sort: 'updated',
    });
    const trashScoped = filterAndSort(all, {
      status: 'trash',
      search,
      category,
      tag,
      sort: 'updated',
    });
    const live = scoped;
    return {
      all: live.length,
      published: live.filter((p) => p.status === 'published').length,
      draft: live.filter((p) => p.status === 'draft').length,
      archived: live.filter((p) => p.status === 'archived').length,
      trash: trashScoped.length,
    } as Record<StatusFilter, number>;
  }, [all, search, category, tag]);

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
    const scoped = filterAndSort(all, {
      status,
      search,
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
      { value: ALL_CATEGORIES, label: `All categories (${scoped.length})` },
      ...listed.map((c) => ({
        value: c,
        label: `${c} (${scoped.filter((p) => p.category === c).length})`,
      })),
    ];
  }, [all, categories, category, status, search, tag]);

  const visible = useMemo(
    () => filterAndSort(all, { status, search, category, tag, sort }),
    [all, status, search, category, tag, sort],
  );

  const totalWords = useMemo(
    () =>
      all
        .filter((p) => p.deletedAt == null)
        .reduce((sum, p) => sum + p.wordCount, 0),
    [all],
  );

  async function newPost() {
    const post = await createPost();
    navigate(`/edit/${post.id}`);
  }

  const filtersActive = search.trim() !== '' || category !== null || tag !== null;
  const showSkeletons = useDelayed(posts === undefined, 220);

  return (
    <div className="dash">
      <header className="dash__masthead">
        <div className="dash__brand">
          <div>
            <h1 className="dash__title">Blog Admin</h1>
            <p className="dash__sub">
              {posts === undefined
                ? 'Opening your library…'
                : `${counts.all} ${counts.all === 1 ? 'post' : 'posts'} · ${totalWords.toLocaleString()} words written · stored on this device`}
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
              if (!file) return;
              setBusy('import');
              try {
                const r = await importBundle(await file.text());
                notify(
                  `Imported ${r.posts} ${r.posts === 1 ? 'post' : 'posts'}, ${
                    r.images
                  } images and ${r.revisions} saved versions`,
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
                onSelect={() => importInput.current?.click()}
              >
                Import a backup
              </MenuItem>
              <MenuItem
                icon={<Download className="ui-ic" />}
                disabled={all.length === 0}
                onSelect={async () => {
                  setBusy('export');
                  try {
                    const n = await downloadJSONBundle();
                    notify(
                      `Exported ${n} ${n === 1 ? 'post' : 'posts'} with images and history`,
                    );
                  } finally {
                    setBusy(null);
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
            </MenuContent>
          </Menu>
          <button className="btn btn--primary" onClick={newPost}>
            <Plus className="ui-ic" aria-hidden="true" />
            New post
          </button>
        </div>
      </header>

      {busy && (
        <div className="dash__busy" role="status">
          <ProgressIndeterminate
            label={busy === 'import' ? 'Importing backup' : 'Preparing export'}
          />
          <span>{busy === 'import' ? 'Importing your backup…' : 'Preparing your export…'}</span>
        </div>
      )}

      {stalled && (
        <div className="notice notice--danger" role="alert">
          <div>
            <strong>Your library isn’t opening.</strong> This usually means
            another tab of Blog Admin is holding the database open. Your posts
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
              onClick={() => void downloadJSONBundle()}
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
              placeholder="Search titles, tags, content…"
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
          </span>
          <button
            className="btn btn--danger btn--sm"
            onClick={() => setConfirm({ kind: 'empty-trash', count: counts.trash })}
          >
            Empty trash
          </button>
        </div>
      )}

      <main className="dash__grid">
        {posts === undefined ? (
          // Held back 220ms: IndexedDB normally answers faster than a person
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
              {confirm.post.wordCount.toLocaleString()} words will be erased from this
              browser. This cannot be undone.
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
  onNew,
  onClear,
}: {
  status: StatusFilter;
  filtersActive: boolean;
  onNew: () => void;
  onClear: () => void;
}) {
  if (filtersActive) {
    return (
      <div className="empty">
        <h2 className="empty__title">Nothing matches</h2>
        <p className="empty__body">
          No posts fit the current search and filters.
        </p>
        <button className="btn btn--outline" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }

  const copy: Record<StatusFilter, { title: string; body: string }> = {
    all: {
      title: 'A blank page, on purpose',
      body: 'Everything you write lives in this browser — no account, no server, no waiting.',
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
      <p className="empty__body">{c.body}</p>
      {status !== 'trash' && status !== 'archived' && (
        <button className="btn btn--primary" onClick={onNew}>
          Write your first post
        </button>
      )}
    </div>
  );
}
