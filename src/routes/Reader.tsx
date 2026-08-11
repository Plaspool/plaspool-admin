import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft } from 'lucide-react';
import { db } from '../data/db';
import { isValidDoc } from '../data/doc';
import { useSettings, TEMPLATES, type ReadingTemplate } from '../data/settings';
import { savePost } from '../data/posts';
import { ArticleTemplate } from '../reader/templates';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import './reader.css';

export default function Reader() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [settings, updateSettings] = useSettings();
  const result = useLiveQuery(async () => ({ post: await db.posts.get(id) }), [id]);
  const post = result?.post;
  const [progress, setProgress] = useState(0);

  const loading = result === undefined;
  const showSkeleton = useDelayed(loading, 220);

  useEffect(() => {
    if (!settings.readingProgress) return;
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [id, settings.readingProgress]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  const doc = useMemo(
    () => (post && isValidDoc(post.content) ? post.content : null),
    [post],
  );

  if (loading) {
    return (
      <div className="reader">
        {/* Nothing at all for the first 220ms — IndexedDB usually answers
            faster than that, and a skeleton that flashes reads as a glitch. */}
        {showSkeleton && (
          <div className="reader__loading" aria-busy="true" aria-label="Loading article">
            <Skeleton height={18} width="30%" />
            <Skeleton height={52} width="80%" />
            <Skeleton height={24} width="55%" />
            <Skeleton height={260} />
          </div>
        )}
      </div>
    );
  }

  if (!post) {
    return (
      <div className="empty">
        <h1 className="empty__title">Post not found</h1>
        <p className="empty__body">It may have been permanently deleted.</p>
        <Link className="btn btn--primary" to="/">
          Back to your posts
        </Link>
      </div>
    );
  }

  const isPreview = post.status !== 'published';
  const pinnedName =
    TEMPLATES.find((t) => t.id === post.template)?.name ?? post.template;

  return (
    <div className="reader">
      {settings.readingProgress && (
        <div
          className="reader__progress"
          style={{ transform: `scaleX(${progress})` }}
          aria-hidden="true"
        />
      )}

      <header className="reader__bar">
        <button className="btn btn--ghost btn--sm" onClick={() => navigate(-1)}>
          <ChevronLeft className="ui-ic" aria-hidden="true" />
          Back
        </button>

        <div className="reader__bar-right">
          {isPreview && <span className="chip chip--draft">Preview</span>}
          {/* The blog-wide default, switchable here as well as in Settings —
              choosing a template is a thing you do while looking at a post.
              Pinning ONE post to its own layout is a different decision and
              lives in the editor's Details panel; the band below says so
              whenever this control isn't the one deciding. */}
          <Select<ReadingTemplate>
            label="Reading layout"
            size="sm"
            value={settings.template}
            onChange={(v) => updateSettings({ template: v })}
            options={TEMPLATES.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Link className="btn btn--outline btn--sm" to={`/edit/${post.id}`}>
            Edit
          </Link>
        </div>
      </header>

      {/*
        Disclosure, not a second picker.
        This post pins its own layout, so the control above is not the one
        deciding what you are looking at — and a control that silently does
        nothing is the failure this codebase keeps finding in its seams. Say so
        where the confusion would happen, and offer the one action that resolves
        it. Setting an override still belongs to the editor's Details panel.
      */}
      {post.template && (
        <div className="reader__pinned" role="status">
          <span>
            This post is pinned to <strong>{pinnedName}</strong>, so the blog
            default doesn’t apply to it.
          </span>
          <button
            className="btn btn--outline btn--sm"
            onClick={() => void savePost(post.id, { template: null })}
          >
            Use the default
          </button>
        </div>
      )}

      <ArticleTemplate post={post} doc={doc} settings={settings} />
    </div>
  );
}
