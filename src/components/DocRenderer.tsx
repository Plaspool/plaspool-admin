import { Fragment, type ReactNode } from 'react';
import { StoredImg } from './StoredImg';
import type { DocNode } from '../data/types';
import { IDB_SCHEME } from '../data/doc';

/**
 * Renders the block document to React elements.
 *
 * Deliberately NOT `dangerouslySetInnerHTML`: nothing in the document can
 * become markup unless it matches a node type listed here. An unknown node
 * renders its children as plain text rather than disappearing or executing.
 * That keeps the reading view safe by construction, today and after a backend
 * starts serving documents written by someone else.
 */

const ALLOWED_PROTOCOL = /^(https?:|mailto:)/i;

export function DocRenderer({ doc }: { doc: DocNode }) {
  return <>{(doc.content ?? []).map((n, i) => renderNode(n, i))}</>;
}

function renderNode(node: DocNode, key: number): ReactNode {
  const kids = () => (node.content ?? []).map((n, i) => renderNode(n, i));

  switch (node.type) {
    case 'text':
      return <Fragment key={key}>{applyMarks(node)}</Fragment>;

    case 'paragraph':
      return <p key={key}>{kids()}</p>;

    case 'heading': {
      const level = Number(node.attrs?.level) === 3 ? 3 : 2;
      const Tag = (level === 3 ? 'h3' : 'h2') as 'h2' | 'h3';
      return <Tag key={key}>{kids()}</Tag>;
    }

    case 'blockquote':
      return (
        <blockquote key={key} className="doc-quote">
          {kids()}
        </blockquote>
      );

    case 'bulletList':
      return <ul key={key}>{kids()}</ul>;
    case 'orderedList':
      return (
        <ol key={key} start={Number(node.attrs?.start) || undefined}>
          {kids()}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{kids()}</li>;

    case 'taskList':
      return (
        <ul key={key} className="doc-tasks">
          {kids()}
        </ul>
      );
    case 'taskItem':
      return (
        <li key={key} data-checked={String(!!node.attrs?.checked)}>
          <label>
            <input type="checkbox" checked={!!node.attrs?.checked} readOnly />
          </label>
          <div>{kids()}</div>
        </li>
      );

    case 'codeBlock':
      return (
        <pre key={key} className="doc-code">
          <code>{plainText(node)}</code>
        </pre>
      );

    case 'horizontalRule':
      return <hr key={key} className="doc-rule" />;

    case 'hardBreak':
      return <br key={key} />;

    case 'image': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '');
      const caption = String(node.attrs?.title ?? '');
      const blobId = src.startsWith(IDB_SCHEME) ? src.slice(IDB_SCHEME.length) : null;
      return (
        <figure key={key} className="doc-figure">
          {blobId ? (
            <StoredImg blobId={blobId} alt={alt} className="doc-image" />
          ) : ALLOWED_PROTOCOL.test(src) ? (
            <img className="doc-image" src={src} alt={alt} loading="lazy" />
          ) : (
            <div className="img-missing" role="img" aria-label={alt || 'Image'}>
              <span>Image unavailable</span>
            </div>
          )}
          {caption && <figcaption className="doc-caption">{caption}</figcaption>}
        </figure>
      );
    }

    default:
      // Unknown block: keep the words, drop the unknown shape.
      return <Fragment key={key}>{kids()}</Fragment>;
  }
}

function applyMarks(node: DocNode): ReactNode {
  let out: ReactNode = node.text ?? '';
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = <strong>{out}</strong>;
        break;
      case 'italic':
        out = <em>{out}</em>;
        break;
      case 'underline':
        out = <u>{out}</u>;
        break;
      case 'strike':
        out = <s>{out}</s>;
        break;
      case 'code':
        out = <code>{out}</code>;
        break;
      case 'link': {
        const href = String(mark.attrs?.href ?? '');
        out = ALLOWED_PROTOCOL.test(href) ? (
          <a className="doc-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
            {out}
          </a>
        ) : (
          out
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function plainText(node: DocNode): string {
  return (node.content ?? []).map((n) => n.text ?? plainText(n)).join('');
}
