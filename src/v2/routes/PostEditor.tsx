import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArchiveRestore, Copy, FileText, PenLine, Trash2, Upload, X } from 'lucide-react';
import { advancedByDefault } from '../lib/editorPref';
import type { CoverImage, Post, PostPatch, PostStatus, ReadingTemplate } from '../../../shared/types';
import { api } from '../../data/api';
import { categoriesApi, type CategorySummary } from '../../data/api-categories';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { ImageError, storeImageFile } from '../../data/images';
import { shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, type BadgeTone } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs } from '../ui/Defs';
import { SelectField, TextArea, TextField } from '../ui/Field';
import { StoredImg } from '../ui/Img';
import { MenuItem, MenuSeparator } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { RichText } from '../ui/RichText';
import { SaveBar } from '../ui/SaveBar';
import { StatusPicker, type StatusOption } from '../ui/StatusPicker';
import { TagInput } from '../ui/TagInput';
import { useToast } from '../ui/Toast';

/**
 * POST EDITOR — `/content/posts/:id`, and `/content/posts/new`.
 *
 * THE LITE CUT, DECIDED: v2 does not restyle v1's writing studio (slash
 * menu, autosave, revision panel, find bar — a session of its own) and it
 * cannot embed it (no v1 component mounts here). What it builds instead is
 * the product page's anatomy over the SAME document schema: title, the
 * RichText surface with images resolving inline, cover, organisation, and a
 * CAS save. Saves are MANUAL (`kind: 'manual'` — kept forever, never
 * pruned like autosaves), and the save bar plus beforeunload carry the
 * don't-lose-work duty autosave carried in v1. Long-form writing days still
 * have the v1 studio; this is the admin's editor for edits.
 *
 * TODO(v2): autosave + the revision history panel; the cover's focal-point
 * reframe; find-in-post. All live in the v1 studio meanwhile.
 */

const STATUS_OPTIONS: StatusOption<PostStatus>[] = [
  { value: 'published', label: 'Published', description: 'Live on the blog and in feeds.' },
  { value: 'draft', label: 'Draft', description: 'Only visible in this admin.' },
  { value: 'archived', label: 'Archived', description: 'Off the blog, kept for the record.' },
];

function postTone(status: PostStatus): BadgeTone {
  if (status === 'published') return 'ok';
  if (status === 'draft') return 'warn';
  return 'neutral';
}

const TEMPLATES: { value: '' | ReadingTemplate; label: string }[] = [
  { value: '', label: 'Blog default' },
  { value: 'magazine', label: 'Magazine' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'editorial', label: 'Editorial' },
  { value: 'technical', label: 'Technical' },
];

export default function PostEditor({ create = false }: { create?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  /* `?editor=quick` is the advanced editor's door back here. Without it the
     device default below would bounce the navigation straight to `/advanced`
     again — the trap the owner walked into: make advanced the default once,
     and no path in the interface ever reached the quick editor again. */
  const [searchParams] = useSearchParams();
  const quickOverride = searchParams.get('editor') === 'quick';
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const [post, setPost] = useState<Post | null>(null);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ── drafts ──────────────────────────────────────────────────────────── */
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [excerpt, setExcerpt] = useState('');
  const [excerptTouched, setExcerptTouched] = useState(false);
  const [template, setTemplate] = useState<'' | ReadingTemplate>('');
  const [cover, setCover] = useState<CoverImage | null>(null);
  const [content, setContent] = useState<unknown>(null);
  const [contentDirty, setContentDirty] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const adoptDrafts = useCallback((next: Post | null) => {
    setTitle(next?.title ?? '');
    setSubtitle(next?.subtitle ?? '');
    setCategory(next?.category ?? '');
    setTags(next?.tags ?? []);
    setExcerpt(next?.excerpt ?? '');
    setExcerptTouched(false);
    setTemplate(next?.template ?? '');
    setCover(next?.coverImage ?? null);
    setContent(next?.content ?? null);
    setContentDirty(false);
    setEditorKey((k) => k + 1);
  }, []);

  const load = useCallback(
    async (adopt: boolean, signal?: AbortSignal) => {
      try {
        const [loaded, cats] = await Promise.all([
          create ? Promise.resolve(null) : api.getPost(id!),
          categoriesApi.list(signal).catch(() => [] as CategorySummary[]),
        ]);
        setPost(loaded);
        setCategories(cats);
        setLoadError(null);
        if (adopt) adoptDrafts(loaded);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    },
    [create, id, adoptDrafts],
  );

  useEffect(() => {
    setPost(null);
    setLoadError(null);
    const controller = new AbortController();
    void load(true, controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty = create
    ? title.trim() !== '' || subtitle.trim() !== '' || tags.length > 0 || cover !== null || contentDirty
    : post
      ? title !== post.title ||
        subtitle !== post.subtitle ||
        category !== post.category ||
        tags.join('\0') !== post.tags.join('\0') ||
        (template || null) !== post.template ||
        JSON.stringify(cover) !== JSON.stringify(post.coverImage) ||
        excerptTouched ||
        contentDirty
      : false;

  const patch = (): PostPatch => ({
    title: title.trim(),
    subtitle: subtitle.trim(),
    category: category.trim(),
    tags,
    template: template === '' ? null : template,
    coverImage: cover,
    /* The excerpt travels ONLY when touched — an untouched derived excerpt
       must keep tracking the opening, and sending it back would pin it. */
    ...(excerptTouched ? { excerpt: excerpt.trim() } : {}),
    ...(content === null ? {} : { content: content as Post['content'] }),
  });

  const merge = (next: Post) => setPost((was) => (was ? { ...was, ...next } : next));

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      if (create) {
        const created = await api.createPost(patch());
        toast.show(`“${created.title || 'Untitled'}” created as a draft`);
        navigate(`/content/posts/${created.id}`, { replace: true });
        return;
      }
      const saved = await api.savePost(post!.id, patch(), {
        baseRevision: post!.revision,
        kind: 'manual',
      });
      merge(saved);
      setExcerptTouched(false);
      setContentDirty(false);
      setConflict(false);
      toast.show('Saved');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      else toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(to: PostStatus) {
    if (!post) return;
    setStatusBusy(true);
    try {
      let latest = post;
      if (post.status === 'draft' && to === 'published') latest = await api.publishPost(post.id);
      else if (post.status === 'published' && to === 'draft') latest = await api.unpublishPost(post.id);
      else if (to === 'archived') latest = await api.archivePost(post.id);
      else if (post.status === 'archived' && to === 'draft') latest = await api.unarchivePost(post.id);
      else if (post.status === 'archived' && to === 'published') {
        await api.unarchivePost(post.id);
        latest = await api.publishPost(post.id);
      }
      merge(latest);
      toast.show(`Now ${latest.status}`);
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    } finally {
      setStatusBusy(false);
    }
  }

  async function lifecycle(run: (id: string) => Promise<Post>, done: string) {
    if (!post) return;
    try {
      merge(await run(post.id));
      toast.show(done);
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
    }
  }

  async function replaceCover(file: File) {
    setCoverBusy(true);
    try {
      const stored = await storeImageFile(file);
      setCover((was) => ({
        blobId: stored.id,
        alt: was?.alt ?? title.trim(),
        focalPoint: was?.focalPoint ?? '50% 50%',
        width: stored.width,
        height: stored.height,
      }));
    } catch (err) {
      toast.show(err instanceof ImageError ? err.message : 'That image could not be added.', 'critical');
    } finally {
      setCoverBusy(false);
    }
  }

  /* The device's chosen editor wins the route. AFTER the hooks (order must
     hold) and BEFORE any fetch result is awaited on screen — the id is in the
     URL, so nothing needs to load before handing over. `create` stays here:
     the advanced editor edits existing posts, and a new draft lands on
     `/content/posts/:id` after create, where this line takes over. */
  if (!create && !quickOverride && advancedByDefault()) {
    return <Navigate to={`/content/posts/${id}/advanced`} replace />;
  }

  if (loadError) {
    return (
      <div className="page">
        <PageHeader icon={<FileText />} title="Post" backTo="/content/posts" backLabel="Blog posts" />
        <Banner tone="critical" title="Couldn’t load this post" action={<Button onClick={() => void load(true)}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }

  if (!create && !post) {
    return (
      <div className="page" aria-busy="true">
        <span className="skel" style={{ width: '5rem' }} />
        <div className="card" style={{ padding: 'var(--s4)' }}>
          <div className="stack stack--tight">
            <span className="skel" style={{ width: '18rem', height: '1rem' }} />
            <span className="skel" style={{ width: '100%', height: '12rem' }} />
          </div>
        </div>
      </div>
    );
  }

  const inTrash = post?.deletedAt != null;
  const categoryNames = categories.map((c) => c.name);
  const categoryKnown = category === '' || categoryNames.includes(category);

  return (
    <div className="page">
      <SaveBar
        when={dirty || saving}
        label={create ? 'Unsaved post' : 'Unsaved changes'}
        saving={saving}
        disabled={title.trim() === ''}
        onDiscard={() => (create ? navigate('/content/posts') : adoptDrafts(post))}
        onSave={() => void save()}
      />

      <PageHeader
        icon={<FileText />}
        title={create ? 'New post' : post!.title || 'Untitled post'}
        titleBadge={create ? null : <Badge tone={postTone(post!.status)}>{post!.status}</Badge>}
        backTo="/content/posts"
        backLabel="Blog posts"
        menu={
          create
            ? undefined
            : (close) => (
                <>
                  {/* The v1 writing studio, back by the owner's request —
                      slash menu, autosave, revisions, find. Settings can make
                      it the default; this entry is the door either way. */}
                  <MenuItem
                    icon={<PenLine aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      navigate(`/content/posts/${post!.id}/advanced`);
                    }}
                  >
                    Open in advanced editor
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Copy aria-hidden="true" />}
                    onSelect={() => {
                      close();
                      void (async () => {
                        try {
                          const copy = await api.duplicatePost(post!.id);
                          toast.show('Duplicated — you are on the copy');
                          navigate(`/content/posts/${copy.id}`);
                        } catch (cause) {
                          toast.show(
                            cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
                            'critical',
                          );
                        }
                      })();
                    }}
                  >
                    Duplicate post
                  </MenuItem>
                  <MenuSeparator />
                  {inTrash ? (
                    <MenuItem
                      icon={<ArchiveRestore aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        void lifecycle(api.restorePost, 'Restored from the trash');
                      }}
                    >
                      Restore from trash
                    </MenuItem>
                  ) : (
                    <MenuItem
                      critical
                      icon={<Trash2 aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setConfirmTrash(true);
                      }}
                    >
                      Move to trash
                    </MenuItem>
                  )}
                  {inTrash && isOwner ? (
                    <MenuItem
                      critical
                      icon={<X aria-hidden="true" />}
                      onSelect={() => {
                        close();
                        setConfirmDestroy(true);
                      }}
                    >
                      Delete forever…
                    </MenuItem>
                  ) : null}
                </>
              )
        }
      />

      {conflict ? (
        <Banner
          tone="warn"
          title="This post changed somewhere else"
          action={
            <Button
              onClick={() => {
                setConflict(false);
                void load(true);
              }}
            >
              Reload
            </Button>
          }
        >
          Probably the v1 studio or another tab. Reloading picks up those changes and discards the
          edits here.
        </Banner>
      ) : null}

      {inTrash ? (
        <Banner
          tone="warn"
          title="In the trash"
          action={<Button onClick={() => void lifecycle(api.restorePost, 'Restored from the trash')}>Restore</Button>}
        >
          Off the blog and out of every list until restored.
        </Banner>
      ) : null}

      <div className="form2">
        <div className="form2__main">
          <Card>
            <TextField
              label="Title"
              value={title}
              placeholder="The story of a spool"
              onChange={(e) => setTitle(e.target.value)}
              error={dirty && title.trim() === '' ? 'A post needs a title.' : null}
              hint={
                create ? undefined : post!.slug ? (
                  <>
                    Path: <span className="mono">/{post!.slug}</span> — assigned by the server,
                    stable once published.
                  </>
                ) : (
                  'No slug yet — assigned when titled or published.'
                )
              }
            />
            <TextField
              label="Subtitle"
              value={subtitle}
              placeholder="Optional dek under the title"
              onChange={(e) => setSubtitle(e.target.value)}
            />
            <div className="field">
              <span className="field__label">Body</span>
              <RichText
                key={editorKey}
                value={create ? null : post!.content}
                allowImages
                placeholder="Tell your story…"
                ariaLabel="Post body"
                onChange={(doc) => {
                  setContent(doc);
                  setContentDirty(true);
                }}
              />
              <span className="field__hint">
                Saves here are manual and kept forever in the history; the v1 studio still has
                autosave, revisions and the slash menu for long writing days.
              </span>
            </div>
          </Card>
        </div>

        <aside className="form2__side">
          {create ? (
            <Card title="Status">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
                New posts are created as <strong>drafts</strong> — publish from this rail once
                saved.
              </p>
            </Card>
          ) : inTrash ? null : (
            <Card title="Status">
              <StatusPicker
                label="Post status"
                value={post!.status}
                options={STATUS_OPTIONS}
                onChange={(to) => void setStatus(to)}
                busy={statusBusy}
              />
              <span className="field__hint">
                {post!.publishedAt ? `First published ${shortDate(post!.publishedAt)}.` : 'Never published yet.'}
              </span>
            </Card>
          )}

          <Card title="Cover">
            {cover ? (
              <>
                <div className="imgg__tile" style={{ aspectRatio: '16 / 10' }}>
                  <StoredImg id={cover.blobId} alt={cover.alt} />
                </div>
                <TextField
                  label="Alt text"
                  value={cover.alt}
                  hint="What a screen reader says the picture is."
                  onChange={(e) => setCover((was) => (was ? { ...was, alt: e.target.value } : was))}
                />
              </>
            ) : (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                No cover — cards and the reader header go without one.
              </p>
            )}
            <div className="row" style={{ gap: 'var(--s2)' }}>
              <Button busy={coverBusy} onClick={() => document.getElementById('post-cover-pick')?.click()}>
                <Upload aria-hidden="true" />
                {cover ? 'Replace' : 'Upload cover'}
              </Button>
              {cover ? (
                <Button tone="plain" onClick={() => setCover(null)}>
                  Remove
                </Button>
              ) : null}
              <input
                id="post-cover-pick"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void replaceCover(file);
                }}
              />
            </div>
          </Card>

          <Card title="Organisation">
            <SelectField
              label="Category"
              value={categoryKnown ? category : ' keep'}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== ' keep') setCategory(v);
              }}
            >
              <option value="">Uncategorised</option>
              {categoryNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {categoryKnown ? null : <option value=" keep">{category} (as stored)</option>}
            </SelectField>
            <TagInput label="Tags" value={tags} onChange={setTags} hint="Free-form on the blog side." />
            <SelectField
              label="Reading template"
              value={template}
              hint="How the reader lays this one out. Default follows the blog setting."
              onChange={(e) => setTemplate(e.target.value as '' | ReadingTemplate)}
            >
              {TEMPLATES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </SelectField>
          </Card>

          <Card title="Search & cards">
            <TextArea
              label="Excerpt"
              rows={3}
              value={excerpt}
              hint={
                !excerptTouched && post?.excerptSource === 'derived'
                  ? 'Currently derived from the opening and tracks it. Editing pins it as written.'
                  : 'Shown on cards and in search results.'
              }
              onChange={(e) => {
                setExcerpt((e.target as HTMLTextAreaElement).value);
                setExcerptTouched(true);
              }}
            />
          </Card>

          {create ? null : (
            <Card title="Details">
              <Defs
                rows={[
                  { label: 'Created', value: shortDate(post!.createdAt) },
                  { label: 'Updated', value: shortDate(post!.updatedAt) },
                  { label: 'Published', value: post!.publishedAt ? shortDate(post!.publishedAt) : '—' },
                ]}
              />
            </Card>
          )}
        </aside>
      </div>

      {confirmTrash && post ? (
        <Modal
          title="Move to trash?"
          onClose={() => setConfirmTrash(false)}
          footer={
            <>
              <Button onClick={() => setConfirmTrash(false)}>Cancel</Button>
              <Button
                tone="critical"
                onClick={() => {
                  setConfirmTrash(false);
                  void lifecycle(api.trashPost, 'Moved to the trash');
                }}
              >
                Move to trash
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            <strong>{post.title || 'This post'}</strong> leaves the blog immediately. Restorable
            until the trash is emptied.
          </p>
        </Modal>
      ) : null}

      {confirmDestroy && post ? (
        <Modal
          title="Delete forever?"
          onClose={() => setConfirmDestroy(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDestroy(false)}>Cancel</Button>
              <Button
                tone="critical"
                onClick={() => {
                  setConfirmDestroy(false);
                  void (async () => {
                    try {
                      await api.destroyPost(post.id);
                      toast.show('Deleted forever');
                      navigate('/content/posts');
                    } catch (cause) {
                      toast.show(
                        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
                        'critical',
                      );
                    }
                  })();
                }}
              >
                Delete forever
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            Gone including its history and revisions — this is the one that cannot be undone.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
