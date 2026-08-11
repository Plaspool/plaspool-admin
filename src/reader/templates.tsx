import { Link } from 'react-router-dom';
import { DocRenderer } from '../components/DocRenderer';
import { StoredImg } from '../components/StoredImg';
import type { Post, DocNode } from '../data/types';
import type { ReadingTemplate, Settings } from '../data/settings';
import './templates.css';

export interface TemplateProps {
  post: Post;
  doc: DocNode | null;
  settings: Settings;
}

function Byline({ post, settings }: { post: Post; settings: Settings }) {
  const author = settings.authorName || post.authorName;
  const dateLine =
    post.status === 'published' && post.publishedAt
      ? new Date(post.publishedAt).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : `Draft · last edited ${new Date(post.updatedAt).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
        })}`;

  return (
    <div className="tpl__byline">
      <span className="tpl__avatar" aria-hidden="true">
        {author.slice(0, 1)}
      </span>
      <div>
        <p className="tpl__author">{author}</p>
        <p className="tpl__dateline">
          {dateLine}
          {settings.showReadingTime && post.wordCount > 0 && (
            <> · {post.readingTime} min read</>
          )}
        </p>
      </div>
    </div>
  );
}

function Body({ post, doc }: { post: Post; doc: DocNode | null }) {
  if (post.wordCount === 0 || !doc) {
    return (
      <div className="tpl__blank">
        <p>This post has no content yet.</p>
        <Link className="btn btn--primary" to={`/edit/${post.id}`}>
          Start writing
        </Link>
      </div>
    );
  }
  return (
    <div className="prose tpl__body">
      <DocRenderer doc={doc} />
    </div>
  );
}

function Tags({ post }: { post: Post }) {
  if (!post.tags.length) return null;
  return (
    <footer className="tpl__tags">
      {post.tags.map((t) => (
        <span key={t} className="chip">
          {t}
        </span>
      ))}
    </footer>
  );
}

/* ------------------------------------------------------------- magazine */

function Magazine({ post, doc, settings }: TemplateProps) {
  return (
    <article className="tpl tpl--magazine">
      <header className="tpl__head">
        {post.category && <p className="tpl__kicker">{post.category}</p>}
        <h1 className="tpl__title">{post.title.trim() || 'Untitled'}</h1>
        {post.subtitle && <p className="tpl__subtitle">{post.subtitle}</p>}
        <Byline post={post} settings={settings} />
      </header>

      {post.coverImage && (
        <figure className="tpl__cover tpl__cover--wide">
          <StoredImg
            blobId={post.coverImage.blobId}
            alt={post.coverImage.alt}
            focalPoint={post.coverImage.focalPoint}
            className="tpl__cover-img"
            eager
          />
          {post.coverImage.alt && (
            <figcaption className="tpl__caption">{post.coverImage.alt}</figcaption>
          )}
        </figure>
      )}

      <Body post={post} doc={doc} />
      <Tags post={post} />
    </article>
  );
}

/* -------------------------------------------------------------- minimal */

function Minimal({ post, doc, settings }: TemplateProps) {
  return (
    <article className="tpl tpl--minimal">
      <header className="tpl__head">
        <h1 className="tpl__title">{post.title.trim() || 'Untitled'}</h1>
        {post.subtitle && <p className="tpl__subtitle">{post.subtitle}</p>}
        <p className="tpl__meta-line">
          {settings.authorName || post.authorName}
          {' · '}
          {post.status === 'published' && post.publishedAt
            ? new Date(post.publishedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Draft'}
          {settings.showReadingTime && post.wordCount > 0 && (
            <> · {post.readingTime} min</>
          )}
        </p>
      </header>
      <Body post={post} doc={doc} />
      <Tags post={post} />
    </article>
  );
}

/* ------------------------------------------------------------ editorial */

function Editorial({ post, doc, settings }: TemplateProps) {
  return (
    <article className="tpl tpl--editorial">
      {post.coverImage && (
        <figure className="tpl__cover tpl__cover--bleed">
          <StoredImg
            blobId={post.coverImage.blobId}
            alt={post.coverImage.alt}
            focalPoint={post.coverImage.focalPoint}
            className="tpl__cover-img"
            eager
          />
        </figure>
      )}
      <header className="tpl__head tpl__head--centred">
        {post.category && <p className="tpl__kicker">{post.category}</p>}
        <h1 className="tpl__title">{post.title.trim() || 'Untitled'}</h1>
        {post.subtitle && <p className="tpl__subtitle">{post.subtitle}</p>}
        <div className="tpl__rule" aria-hidden="true" />
        <Byline post={post} settings={settings} />
      </header>
      <Body post={post} doc={doc} />
      <Tags post={post} />
    </article>
  );
}

/* ------------------------------------------------------------ technical */

function Technical({ post, doc, settings }: TemplateProps) {
  return (
    <article className="tpl tpl--technical">
      <div className="tpl__rail">
        <dl className="tpl__facts">
          <div>
            <dt>Author</dt>
            <dd>{settings.authorName || post.authorName}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className="tpl__facts-status">{post.status}</dd>
          </div>
          {post.publishedAt && (
            <div>
              <dt>Published</dt>
              <dd>
                <time dateTime={new Date(post.publishedAt).toISOString()}>
                  {new Date(post.publishedAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </dd>
            </div>
          )}
          {post.category && (
            <div>
              <dt>Category</dt>
              <dd>{post.category}</dd>
            </div>
          )}
          <div>
            <dt>Length</dt>
            <dd>
              {post.wordCount.toLocaleString()} words
              {settings.showReadingTime && post.wordCount > 0 && (
                <> · {post.readingTime} min</>
              )}
            </dd>
          </div>
        </dl>
        {post.tags.length > 0 && (
          <div className="tpl__rail-tags">
            {post.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="tpl__main">
        <header className="tpl__head">
          <h1 className="tpl__title">{post.title.trim() || 'Untitled'}</h1>
          {post.subtitle && <p className="tpl__subtitle">{post.subtitle}</p>}
        </header>
        {post.coverImage && (
          <figure className="tpl__cover">
            <StoredImg
              blobId={post.coverImage.blobId}
              alt={post.coverImage.alt}
              focalPoint={post.coverImage.focalPoint}
              className="tpl__cover-img"
              eager
            />
          </figure>
        )}
        <Body post={post} doc={doc} />
      </div>
    </article>
  );
}

const REGISTRY: Record<ReadingTemplate, (p: TemplateProps) => React.ReactElement> = {
  magazine: Magazine,
  minimal: Minimal,
  editorial: Editorial,
  technical: Technical,
};

/**
 * The one place a layout is chosen.
 *
 * A post may pin its own (the essay that wants the full-bleed treatment);
 * otherwise it follows the blog's default. `?? Magazine` stays as the floor for
 * a document carrying a template name this build doesn't have — a real case
 * once posts arrive from a server, and one that must render rather than throw.
 */
export function resolveTemplate(
  post: Pick<Post, 'template'>,
  settings: Settings,
): ReadingTemplate {
  return post.template ?? settings.template;
}

export function ArticleTemplate(props: TemplateProps) {
  const Chosen = REGISTRY[resolveTemplate(props.post, props.settings)] ?? Magazine;
  return <Chosen {...props} />;
}
