import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, Star, X } from 'lucide-react';
import type { FeaturedItem, ListPost } from '../../../shared/types';
import { api } from '../../data/api';
import { FeaturedConflictError } from '../../data/errors';
import { getSession } from '../../data/session';
import { shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { StoredImg } from '../ui/Img';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * FEATURED — `/content/featured`. The curated rail the storefront shows
 * first: up to four published posts, in an order somebody chose.
 *
 * EVERY WRITE ANSWERS WITH THE WHOLE RAIL, and the screen adopts that answer
 * — including the 409s. `featured_full` and `featured_stale` both carry the
 * server's current items, so a conflict never strands the screen on a rail
 * that no longer exists: it shows the truth and says what happened.
 *
 * Writers see the rail read-only; only the owner curates (v1's rule, kept).
 *
 * TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: a stale reorder adopts the server's items rather than retrying,
 * and the full-rail path routes through the replace picker.
 */
export default function Featured() {
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const [items, setItems] = useState<FeaturedItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listFeatured());
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Adopt whatever the server says the rail is now — success or conflict. */
  function adopt(next: FeaturedItem[]) {
    setItems([...next].sort((a, b) => a.rank - b.rank));
  }

  async function move(index: number, dir: -1 | 1) {
    if (!items || busy) return;
    const next = [...items];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap]!, next[index]!];
    setBusy(true);
    try {
      adopt(await api.reorderFeatured(next.map((i) => i.id)));
    } catch (cause) {
      if (cause instanceof FeaturedConflictError) {
        adopt(cause.items);
        toast.show('The rail changed somewhere else — showing the latest order', 'critical');
      } else {
        toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: FeaturedItem) {
    if (busy) return;
    setBusy(true);
    try {
      adopt(await api.unfeaturePost(item.id));
      toast.show(`“${item.title}” removed from the rail`);
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        icon={<Star />}
        title="Featured"
        subtitle="The rail the storefront shows first — up to four published posts, in your order."
        actions={
          isOwner ? (
            <Button tone="primary" size="lg" onClick={() => setPicking(true)}>
              <Plus aria-hidden="true" />
              Feature a post
            </Button>
          ) : undefined
        }
      />

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load the rail" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      {!isOwner ? (
        <Banner tone="info" title="Read-only">
          Curating the rail is the owner’s call — writers see it as the storefront will.
        </Banner>
      ) : null}

      {items === null && !loadError ? (
        <Card flush>
          <div className="card__body stack" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="row" style={{ gap: 'var(--s3)' }}>
                <span className="skel skel--thumb" />
                <span className="skel" style={{ width: `${13 - i * 2}rem` }} />
              </div>
            ))}
          </div>
        </Card>
      ) : items && items.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<Star />}
            title="Nothing featured yet"
            body="The storefront leads with this rail. Feature up to four published posts and put the best one first."
            actions={
              isOwner ? (
                <Button tone="primary" onClick={() => setPicking(true)}>
                  <Plus aria-hidden="true" />
                  Feature a post
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : items ? (
        <Card flush>
          <ol>
            {items.map((item, index) => (
              <li
                key={item.id}
                className="row"
                style={{
                  gap: 'var(--s3)',
                  padding: 'var(--s3) var(--s4)',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border-sub)',
                }}
              >
                <span
                  className="num muted"
                  aria-hidden="true"
                  style={{ width: '1.25rem', textAlign: 'center', fontSize: 'var(--t-lg)', fontWeight: 'var(--w-semi)' }}
                >
                  {index + 1}
                </span>
                <span className="idcell__thumb" aria-hidden="true">
                  {item.coverImage ? <StoredImg id={item.coverImage.blobId} /> : <Star />}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="idcell__title" style={{ display: 'block' }}>
                    {item.title}
                  </span>
                  <span className="idcell__meta">
                    <span className="mono">/{item.slug}</span> · published {shortDate(item.publishedAt)}
                  </span>
                </span>
                {isOwner ? (
                  <span className="row" style={{ gap: 'var(--s1)' }}>
                    <Button
                      tone="plain"
                      iconOnly
                      aria-label={`Move “${item.title}” up`}
                      disabled={busy || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      tone="plain"
                      iconOnly
                      aria-label={`Move “${item.title}” down`}
                      disabled={busy || index === items.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      tone="plain"
                      iconOnly
                      aria-label={`Remove “${item.title}” from the rail`}
                      disabled={busy}
                      onClick={() => void remove(item)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </span>
                ) : (
                  <Badge tone="info">Rank {item.rank}</Badge>
                )}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <p className="page__learn">
        Only publicly visible posts can be featured — unpublishing one drops it off the rail.
      </p>

      {picking && items ? (
        <FeaturePicker
          current={items}
          onClose={() => setPicking(false)}
          onDone={(next) => {
            adopt(next);
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The picker, with the FULL-RAIL PATH built in: featuring a fifth post is a
 * 409 carrying the current four, and the modal turns that answer into the
 * question it implies — "replace which one?" — rather than surfacing an
 * error about a rule the person could not see.
 */
function FeaturePicker({
  current,
  onClose,
  onDone,
}: {
  current: FeaturedItem[];
  onClose: () => void;
  onDone: (items: FeaturedItem[]) => void;
}) {
  const toast = useToast();
  const [candidates, setCandidates] = useState<ListPost[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** Set when the rail answered "full": the post waiting for a slot. */
  const [pending, setPending] = useState<{ id: string; title: string; items: FeaturedItem[] } | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    api
      .listPosts({ status: 'published', limit: 50 })
      .then((page) => {
        if (live) setCandidates(page.items);
      })
      .catch(() => {
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const featured = useMemo(() => new Set(current.map((i) => i.id)), [current]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (candidates ?? [])
      .filter((p) => !featured.has(p.id))
      .filter((p) => !q || p.title.toLowerCase().includes(q));
  }, [candidates, featured, query]);

  async function feature(post: ListPost, replace?: string) {
    setBusy(post.id);
    try {
      const next = await api.featurePost(post.id, replace);
      toast.show(`“${post.title}” is on the rail`);
      onDone(next);
    } catch (cause) {
      if (cause instanceof FeaturedConflictError && cause.reason === 'featured_full') {
        setPending({ id: post.id, title: post.title, items: cause.items });
      } else if (cause instanceof FeaturedConflictError) {
        toast.show('The rail changed somewhere else — showing the latest', 'critical');
        onDone(cause.items);
      } else {
        toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      }
    } finally {
      setBusy(null);
    }
  }

  async function featureReplacing(replaceId: string) {
    if (!pending) return;
    setBusy(pending.id);
    try {
      const next = await api.featurePost(pending.id, replaceId);
      toast.show(`“${pending.title}” is on the rail`);
      onDone(next);
    } catch (cause) {
      if (cause instanceof FeaturedConflictError) {
        toast.show('The rail changed somewhere else — showing the latest', 'critical');
        onDone(cause.items);
      } else {
        toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      }
    } finally {
      setBusy(null);
    }
  }

  if (pending) {
    return (
      <Modal title="The rail is full" onClose={() => setPending(null)} flush>
        <div style={{ padding: 'var(--s2) var(--s5) var(--s3)' }}>
          <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
            Four posts is the rail’s whole width. Featuring{' '}
            <strong style={{ color: 'var(--ink-strong)' }}>{pending.title}</strong> means one of
            these steps down:
          </p>
        </div>
        {pending.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="pick"
            disabled={busy !== null}
            onClick={() => void featureReplacing(item.id)}
          >
            <span className="idcell__thumb pick__icon" aria-hidden="true">
              {item.coverImage ? <StoredImg id={item.coverImage.blobId} /> : <Star />}
            </span>
            <span>
              <span className="pick__title">{item.title}</span>
              <span className="pick__body" style={{ display: 'block' }}>
                Rank {item.rank} · published {shortDate(item.publishedAt)}
              </span>
            </span>
            <span className="pick__chev">Replace</span>
          </button>
        ))}
      </Modal>
    );
  }

  return (
    <Modal title="Feature a post" onClose={onClose} flush wide>
      <div className="tfilter" style={{ borderBottom: '1px solid var(--border-sub)' }}>
        <div className="tfilter__search">
          <Search aria-hidden="true" />
          <input
            className="input"
            type="search"
            autoFocus
            placeholder="Search published posts"
            aria-label="Search published posts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {candidates === null ? (
        <div className="stack" style={{ padding: 'var(--s4) var(--s5)' }} aria-hidden="true">
          <span className="skel" style={{ width: '15rem' }} />
          <span className="skel" style={{ width: '11rem', opacity: 0.7 }} />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 'var(--s6) var(--s5)', textAlign: 'center' }} className="muted">
          {query
            ? 'No published post matches that.'
            : 'Every published post is already on the rail — or nothing is published yet.'}
        </div>
      ) : (
        rows.map((post) => (
          <div key={post.id} className="pick" style={{ cursor: 'default' }}>
            <span className="idcell__thumb pick__icon" aria-hidden="true">
              {post.coverImage ? <StoredImg id={post.coverImage.blobId} /> : <Star />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="pick__title">{post.title}</span>
              <span className="pick__body" style={{ display: 'block' }}>
                {post.publishedAt ? `Published ${shortDate(post.publishedAt)}` : 'Published'}
              </span>
            </span>
            <Button busy={busy === post.id} onClick={() => void feature(post)}>
              Feature
            </Button>
          </div>
        ))
      )}
    </Modal>
  );
}
