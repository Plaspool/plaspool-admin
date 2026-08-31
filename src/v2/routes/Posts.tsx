import { useMemo, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import type { ListPost, PostStatus } from '../../../shared/types';
import { api } from '../../data/api';
import { useAsync } from '../lib/useAsync';
import { humanise, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState, type BadgeTone } from '../ui/primitives';
import { PageArt } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';

/**
 * BLOG POSTS — and this is the screen the whole "home page separate from the
 * blog page" instruction was about.
 *
 * v1 boots to `/dashboard`, which IS the post list, so the first thing an
 * ecommerce admin sees is a writing tool. v2 boots to `/home`, and the blog is
 * a section under Content like any other. Nothing about the posts changed; what
 * changed is that they stopped being the front door.
 *
 * IT READS THE SERVER DIRECTLY, not the Dexie mirror. v1's dashboard is built
 * on the offline cache with a live query over it, which is the right design for
 * a writing tool somebody opens on a train. This list is a management view
 * inside an admin that is useless offline anyway — every other v2 screen here
 * is a live shop read — so it takes the simpler path and asks the API.
 */

const TABS: { value: PostStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Drafts' },
  { value: 'archived', label: 'Archived' },
];

function postTone(status: PostStatus): BadgeTone {
  if (status === 'published') return 'ok';
  if (status === 'draft') return 'warn';
  return 'neutral';
}

export default function Posts() {
  const [shown, toggle] = useAnalyticsBar('posts');
  const [tab, setTab] = useState<PostStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];

  const { data, error, loading } = useAsync(
    () =>
      api.listPosts({
        ...(tab === 'all' ? {} : { status: tab }),
        ...(cursor ? { cursor } : {}),
        limit: 25,
      }),
    [tab, cursor],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q) ||
        (p.authorName ?? '').toLowerCase().includes(q),
    );
  }, [all, search]);

  const metrics: Metric[] = useMemo(
    () => [
      { label: 'Posts on this page', value: String(all.length) },
      { label: 'Published', value: String(all.filter((p) => p.status === 'published').length) },
      { label: 'Drafts', value: String(all.filter((p) => p.status === 'draft').length) },
      {
        label: 'Words',
        value: all.reduce((n, p) => n + (p.wordCount ?? 0), 0).toLocaleString(),
      },
      {
        label: 'Avg. read',
        value: all.length
          ? `${Math.round(all.reduce((n, p) => n + (p.readingTime ?? 0), 0) / all.length)} min`
          : '—',
      },
    ],
    [all],
  );

  const columns: Column<ListPost>[] = [
    {
      key: 'post',
      header: 'Post',
      primary: true,
      render: (p) => (
        <IdCell
          thumb={<FileText aria-hidden="true" />}
          title={p.title || 'Untitled'}
          meta={p.slug ? <span className="mono">/{p.slug}</span> : 'No link name yet'}
          href={`/content/posts/${p.id}`}
        />
      ),
    },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      tight: true,
      render: (p) =>
        p.deletedAt ? (
          <Badge tone="critical">In trash</Badge>
        ) : (
          <Badge tone={postTone(p.status)}>{humanise(p.status)}</Badge>
        ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (p) => p.category || <span className="muted">Uncategorised</span>,
    },
    { key: 'author', header: 'Author', render: (p) => p.authorName || <span className="muted">—</span> },
    { key: 'words', header: 'Words', numeric: true, render: (p) => (p.wordCount ?? 0).toLocaleString() },
    {
      key: 'when',
      header: 'Published',
      render: (p) =>
        p.publishedAt ? shortDate(p.publishedAt) : <span className="muted">Not published</span>,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<FileText />}
        title="Blog posts"
        subtitle="The writing side of the shop."
        actions={
          <ButtonLink tone="primary" size="lg" to="/content/posts/new">
            <Plus aria-hidden="true" />
            New post
          </ButtonLink>
        }
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load posts">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Blog posts"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        loading={loading}
        tabs={{
          value: tab,
          tabs: TABS,
          onChange: (next) => {
            setCursors([undefined]);
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Filter the posts on this page',
          onChange: setSearch,
        }}
        empty={
          (
            <EmptyState
              icon={search ? <FileText /> : undefined}
              art={search ? undefined : <PageArt />}
              title={search ? 'No posts match that filter' : 'Nothing written here yet'}
              body={
                search
                  ? 'This only searches the posts on this page.'
                  : 'Posts you write show up here with their status, category and word count.'
              }
              actions={search ? <Button onClick={() => setSearch('')}>Clear filter</Button> : null}
            />
          )
        }
        footer={
          <TablePager
            note={`${rows.length} shown`}
            canPrev={cursors.length > 1}
            canNext={Boolean(data?.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => setCursors((c) => [...c, data?.nextCursor ?? undefined])}
          />
        }
      />

      <p className="page__learn">
        Open a post to edit it. You get the quick editor by default, or the advanced editor from More
        actions. You can make either one your default in Settings.
      </p>
    </div>
  );
}
