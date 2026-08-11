import { Fragment, type ReactNode } from 'react';
import { StoredImg } from './StoredImg';
import type { DocNode } from '../data/types';
import { IDB_SCHEME } from '../data/doc';
import { isAllowedHref, isAllowedImageSrc } from '../data/docguards';
import { lowlight } from '../editor/extensions';

/**
 * Renders the block document to React elements.
 *
 * Deliberately NOT `dangerouslySetInnerHTML`: nothing in the document can
 * become markup unless it matches a node type listed here. An unknown node
 * renders its children as plain text rather than disappearing or executing.
 * That keeps the reading view safe by construction, today and after a backend
 * starts serving documents written by someone else.
 *
 * Syntax highlighting obeys the same rule. lowlight hands back a hast tree, and
 * the walk below turns it into `<span>`s with `hljs-*` class names and nothing
 * else — no tag it did not expect, no attribute, no markup string. Highlighting
 * a code block is the one place it would have been tempting to reach for
 * `innerHTML`, which is exactly why it doesn't.
 */

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

    /*
     * Checklists are the one block where the editor uses a node view, so its
     * DOM is fixed: li > label(input + span) + div. These two arms emit the
     * same boxes — including the empty <span>, without which the label lays
     * out differently here than it does in the editor and prose.css stops
     * describing both surfaces. `data-type` matches TipTap's own serialisation
     * so this markup parses back into a taskList/taskItem rather than a plain
     * list; the editor's node view omits it on the <li>, so no CSS may key off
     * it. See ARCHITECTURE.md §5.
     */
    case 'taskList':
      return (
        <ul key={key} className="doc-tasks" data-type="taskList">
          {kids()}
        </ul>
      );
    case 'taskItem': {
      const checked = !!node.attrs?.checked;
      return (
        <li key={key} data-checked={String(checked)} data-type="taskItem">
          <label>
            <input
              type="checkbox"
              checked={checked}
              readOnly
              aria-label={`Task item checkbox for ${plainText(node) || 'empty task item'}`}
            />
            <span />
          </label>
          <div>{kids()}</div>
        </li>
      );
    }

    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '');
      return (
        <pre key={key} className="doc-code">
          <code className={language ? `language-${language}` : undefined}>
            {highlight(plainText(node), language)}
          </code>
        </pre>
      );
    }

    /*
     * Tables. Without these four arms the `default:` below flattens a table
     * into one undifferentiated run of cell text — the editor would show a
     * grid and the article would show a sentence. `colwidth` is carried across
     * too, or the two surfaces disagree about column widths, and prose.css is
     * meant to describe both (ARCHITECTURE.md §5).
     */
    case 'table':
      return (
        <div
          key={key}
          className="doc-table-wrap"
          // A scroll container that only a mouse can reach is a trap, and on a
          // narrow screen this one always overflows. Give it a tab stop.
          tabIndex={0}
          role="region"
          aria-label="Table"
        >
          <table className="doc-table">
            {colGroup(node)}
            <tbody>{kids()}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={key}>{kids()}</tr>;
    case 'tableHeader':
      return (
        <th key={key} className="doc-th" {...cellSpans(node)}>
          {kids()}
        </th>
      );
    case 'tableCell':
      return (
        <td key={key} className="doc-td" {...cellSpans(node)}>
          {kids()}
        </td>
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
          ) : isAllowedImageSrc(src) ? (
            // A pasted remote image is kept rather than dropped — losing the
            // picture would be worse — but it is the one thing in the app that
            // reaches off this device, so it leaks nothing on the way out.
            <img
              className="doc-image"
              src={src}
              alt={alt}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
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
        // Same predicate the editor's Link extension gates on, so the two
        // surfaces cannot disagree about what counts as a link.
        out = isAllowedHref(href) ? (
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

function cellSpans(node: DocNode) {
  const colSpan = Number(node.attrs?.colspan) || 1;
  const rowSpan = Number(node.attrs?.rowspan) || 1;
  return {
    colSpan: colSpan > 1 ? colSpan : undefined,
    rowSpan: rowSpan > 1 ? rowSpan : undefined,
  };
}

/**
 * Column widths live on the first row's cells, the same place ProseMirror's
 * table view reads them from, so a resized table reads at the width it was
 * written at.
 */
function colGroup(table: DocNode): ReactNode {
  const firstRow = (table.content ?? []).find((n) => n.type === 'tableRow');
  if (!firstRow) return null;
  const widths: (number | null)[] = [];
  for (const cell of firstRow.content ?? []) {
    const span = Number(cell.attrs?.colspan) || 1;
    const cw = cell.attrs?.colwidth;
    const list = Array.isArray(cw) ? (cw as unknown[]) : null;
    for (let i = 0; i < span; i += 1) {
      const w = Number(list?.[i]);
      widths.push(Number.isFinite(w) && w > 0 ? w : null);
    }
  }
  if (!widths.some((w) => w !== null)) return null;
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={w ? { width: w } : undefined} />
      ))}
    </colgroup>
  );
}

/**
 * lowlight → React, with the same allow-list discipline as the rest of this
 * file: only `span`, only `hljs-*` class names, text otherwise. An unregistered
 * or absent language falls through to plain text rather than guessing, because
 * `highlightAuto` on every code block in a long post is not free and a wrong
 * guess colours the code as something it isn't.
 */
type Hast = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Hast[] };

function highlight(code: string, language: string): ReactNode {
  if (!code) return code;
  if (!language || language === 'plaintext' || !lowlight.registered(language)) return code;
  try {
    const tree = lowlight.highlight(language, code) as unknown as Hast;
    return (tree.children ?? []).map((n, i) => hastToReact(n, i));
  } catch {
    return code;
  }
}

function hastToReact(node: Hast, key: number): ReactNode {
  if (node.type === 'text') return <Fragment key={key}>{node.value ?? ''}</Fragment>;
  if (node.type !== 'element' || node.tagName !== 'span') {
    return <Fragment key={key}>{(node.children ?? []).map((c, i) => hastToReact(c, i))}</Fragment>;
  }
  const raw = node.properties?.className;
  const classes = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/) : [])
    .map(String)
    .filter((c) => /^hljs(-[a-z0-9_]+)*$/i.test(c));
  return (
    <span key={key} className={classes.join(' ') || undefined}>
      {(node.children ?? []).map((c, i) => hastToReact(c, i))}
    </span>
  );
}
