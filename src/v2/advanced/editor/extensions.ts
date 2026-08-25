import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { StudioImage } from './ImageNode';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CharacterCount from '@tiptap/extension-character-count';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { TableKit } from '@tiptap/extension-table';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { IDB_SCHEME, imageIdFromSrc } from '../data/doc';
import { isAllowedHref, isAllowedImageSrc } from '../data/docguards';
import { ImageError, storeImageFile } from '../data/images';

/**
 * The block schema. Deliberately small and stable — every node here maps to a
 * block type the future backend can store and diff independently.
 */

/**
 * Grammars, registered one by one rather than via lowlight's `common` bundle.
 *
 * Two reasons, and size is the second one. The first is that the picker and the
 * highlighter now come from the same list by construction: with `common` the
 * editor could highlight a language the picker never offered, and a document
 * could carry a `language` attribute with nothing in the UI that set it.
 * (`all` is 190+ grammars and was never on the table.)
 */
const GRAMMARS: [value: string, label: string, grammar: Parameters<
  ReturnType<typeof createLowlight>['register']
>[1]][] = [
  ['typescript', 'TypeScript', typescript],
  ['javascript', 'JavaScript', javascript],
  ['json', 'JSON', json],
  ['bash', 'Shell', bash],
  ['css', 'CSS', css],
  ['xml', 'HTML / XML', xml],
  ['python', 'Python', python],
  ['rust', 'Rust', rust],
  ['go', 'Go', go],
  ['sql', 'SQL', sql],
  ['markdown', 'Markdown', markdown],
  ['yaml', 'YAML', yaml],
  ['diff', 'Diff', diff],
];

export const lowlight = createLowlight();
for (const [value, , grammar] of GRAMMARS) lowlight.register(value, grammar);

/**
 * `plaintext` MUST be registered, even though it produces no colour.
 *
 * CodeBlockLowlight falls back to `lowlight.highlightAuto()` for any language
 * it doesn't find registered. So leaving `plaintext` out — and it is also the
 * `defaultLanguage`, i.e. what every code block with no language set resolves
 * to — meant the editor cheerfully guessed and coloured a block as SQL while
 * the reader, which deliberately refuses to guess, shipped it monochrome. The
 * picker said "Plain text" and the editor disagreed with both it and the
 * article. Registering the no-op grammar makes "plaintext" mean the same thing
 * on all three.
 */
lowlight.register('plaintext', plaintext);

/** Offered in the language picker, in the order a blog actually uses them. */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'plaintext', label: 'Plain text' },
  ...GRAMMARS.map(([value, label]) => ({ value, label })),
];

// --------------------------------------------------------------- paste repair

/**
 * Paste repair.
 *
 * Everything a writer pastes arrives as someone else's HTML: Google Docs wraps
 * the document in `<b style="font-weight:normal">`, Word ships `<o:p>` and a
 * kilobyte of `mso-` styles per paragraph, Notion writes checkboxes as plain
 * list items, and any web page can carry markup we must never execute.
 *
 * The rules below are ordered: strip what is dangerous, then strip what is
 * noise, then *translate* what is meaningful into shapes this schema has. The
 * invariant across all of it is that no words are lost — a repair that drops a
 * sentence is worse than one that drops a font.
 */

/** Never survives a paste, regardless of source. */
const NEVER_PASTE = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'noscript',
  'link',
  'meta',
  'base',
  'form',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
  'template',
].join(',');

/**
 * The only inline styles worth keeping: the ones TipTap's own mark parsers
 * read. Everything else — `mso-*`, `font-family`, colours, spacing — is the
 * source application describing its own canvas, not the writing. Dropping the
 * rest is what turns a Word paste back into text.
 */
const KEEP_STYLE = /^(font-weight|font-style|text-decoration|text-decoration-line)$/i;

function stripHostile(doc: Document) {
  doc.querySelectorAll(NEVER_PASTE).forEach((el) => el.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // Event handlers are the whole attack surface of a pasted fragment.
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const kept = attr.value
          .split(';')
          .map((d) => d.trim())
          .filter((d) => KEEP_STYLE.test(d.split(':')[0]?.trim() ?? ''));
        if (kept.length) el.setAttribute('style', kept.join('; '));
        else el.removeAttribute('style');
        continue;
      }
      if ((name === 'href' || name === 'xlink:href') && !isAllowedHref(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  // An anchor whose href we just dropped is no longer a link — unwrap it so the
  // words stay and the affordance doesn't lie.
  doc.querySelectorAll('a:not([href])').forEach((el) => unwrap(el));

  /*
   * Images are the one src we resolve ourselves, and THIS IS THE ONLY GATE THEY
   * HAVE. Measured on this repo's TipTap 3.29: the ProseMirror parse keeps an
   * `<img>` with any src at all — `javascript:`, a relative path, anything —
   * and only `allowBase64: false` removes one (`data:`). So a src that reaches
   * a document is a src this line let through.
   *
   * `imageIdFromSrc` REPLACES A HAND-ROLLED `startsWith(IDB_SCHEME)`, and that
   * is a data-loss fix rather than a tidy-up. Measured before the change:
   * `repairPastedHTML('<p>x</p><img src="asset:img_abc">')` returned
   * `'<p>x</p>'`. After migration every image in every post is `asset:`, so
   * copying a section from one post into another silently deleted the
   * pictures — against the invariant the block comment at the top of this
   * section states in its own words ("no words are lost"), and with no error
   * anywhere. One predicate, `shared/doc.ts`'s, now decides for both schemes at
   * all three sites that ask the question (here, `DocRenderer`, `ImageNode`).
   *
   * A `data:` URI reaching here means the paste handler didn't intercept it
   * (plain `insertContent`, say), and the schema would drop it silently anyway —
   * so drop it explicitly, and keep the image count honest.
   */
  doc.querySelectorAll('img').forEach((el) => {
    const src = el.getAttribute('src') ?? '';
    if (imageIdFromSrc(src) === null && !isAllowedImageSrc(src)) el.remove();
  });
}

function stripChrome(doc: Document) {
  // Word/Outlook namespaced elements (`<o:p>`, `<w:sdt>`, `<v:shape>`): the
  // tags carry no meaning here, but their text sometimes does.
  doc.querySelectorAll('*').forEach((el) => {
    if (el.tagName.includes(':')) unwrap(el);
  });

  // Google Docs wraps its whole payload in a bold element that then disclaims
  // itself. TipTap's `b` parser already checks `font-weight: normal`, but the
  // wrapper also nests every block one level deeper than it needs to be.
  doc.querySelectorAll('b[style], span[style]').forEach((el) => {
    if (/font-weight:\s*normal/i.test(el.getAttribute('style') ?? '')) unwrap(el);
  });

  // `<span>` carries no block or mark meaning in this schema. Once its styles
  // are gone it is pure nesting, and nesting is what makes a Word paste slow.
  doc.querySelectorAll('span:not([style])').forEach((el) => unwrap(el));

  // Classes are the source app's stylesheet hooks and mean nothing here — with
  // one exception: `language-*` on a code element is the only place a pasted
  // code block records what language it is, and CodeBlock's parser reads it.
  doc.querySelectorAll('[class]').forEach((el) => {
    const kept = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((c) => /^(language|lang)-[a-z0-9+#-]+$/i.test(c));
    if (kept.length && /^(CODE|PRE)$/.test(el.tagName)) el.setAttribute('class', kept.join(' '));
    else el.removeAttribute('class');
  });

  // Word brackets its list items in conditional comments.
  removeComments(doc.body);
}

function removeComments(root: Node) {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === 8) child.parentNode?.removeChild(child);
    else if (child.nodeType === 1) removeComments(child);
  }
}

/**
 * The schema has two heading levels — the article's own `<h1>` is the title
 * field — so a pasted `<h1>` would otherwise be demoted to a paragraph and the
 * structure of an imported draft would vanish. Remap instead of drop.
 */
function demoteHeadings(doc: Document) {
  doc.querySelectorAll('h1').forEach((el) => rename(doc, el, 'h2'));
  doc.querySelectorAll('h4, h5, h6').forEach((el) => rename(doc, el, 'h3'));
}

/**
 * A web article's image caption lives in `<figcaption>`, and this schema keeps
 * a caption on the image node's `title`. Without this, pasting a figure kept
 * the picture and turned its caption into a stray paragraph underneath.
 */
function liftFigureCaptions(doc: Document) {
  doc.querySelectorAll('figure').forEach((fig) => {
    const img = fig.querySelector('img');
    const cap = fig.querySelector('figcaption');
    if (img && cap) {
      const text = (cap.textContent ?? '').trim();
      // Not truncated to the caption field's `maxLength`. That cap governs what
      // a writer can type; silently amputating a caption they pasted is losing
      // their words on the way in, which is the one thing paste must never do.
      if (text && !img.getAttribute('title')) img.setAttribute('title', text);
      cap.remove();
    }
    unwrap(fig);
  });

  // `<blockquote><cite>` — the attribution is part of the quote, not a sibling.
  doc.querySelectorAll('blockquote cite').forEach((cite) => {
    const text = (cite.textContent ?? '').trim();
    if (!text) return;
    const p = doc.createElement('p');
    p.textContent = `— ${text}`;
    cite.replaceWith(p);
  });
}

/**
 * Notion (and most editors) export a checklist as an ordinary list whose items
 * open with a checkbox input. Left alone that becomes a bullet list with the
 * checkboxes stripped, so the *state* of every item is lost. TaskList parses
 * `data-type`, so translate rather than discard.
 */
function normaliseCheckboxLists(doc: Document) {
  doc.querySelectorAll('ul, ol').forEach((list) => {
    const items = [...list.children].filter((c) => c.tagName === 'LI');
    if (!items.length) return;
    const withBoxes = items.filter((li) => li.querySelector('input[type="checkbox"]'));
    if (withBoxes.length !== items.length) return;

    list.setAttribute('data-type', 'taskList');
    items.forEach((li) => {
      const box = li.querySelector('input[type="checkbox"]');
      const checked = box?.hasAttribute('checked') || box?.getAttribute('data-checked') === 'true';
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', String(!!checked));
      box?.remove();
    });
  });
  // Any checkbox that wasn't part of a list is chrome, not content.
  doc.querySelectorAll('input').forEach((el) => el.remove());
}

/**
 * Tables are real nodes now, so rows are no longer flattened to `cell · cell`.
 * What the schema still can't hold is a table inside a table cell — Word and
 * Google Docs both use those for layout — so the inner table is reduced to text
 * inside its host cell rather than dropped.
 */
function flattenNestedTables(doc: Document) {
  let guard = 0;
  let inner = doc.querySelector('table table');
  while (inner && guard++ < 50) {
    const rows = [...inner.querySelectorAll('tr')].map((row) =>
      [...row.querySelectorAll('th, td')]
        .map((c) => (c.textContent ?? '').trim())
        .filter(Boolean)
        .join(' · '),
    );
    const p = doc.createElement('p');
    p.textContent = rows.filter(Boolean).join(' — ');
    inner.replaceWith(p);
    inner = doc.querySelector('table table');
  }
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function rename(doc: Document, el: Element, tag: string) {
  const next = doc.createElement(tag);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
}

export function repairPastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  stripHostile(doc);
  stripChrome(doc);
  demoteHeadings(doc);
  liftFigureCaptions(doc);
  normaliseCheckboxLists(doc);
  flattenNestedTables(doc);
  return doc.body.innerHTML;
}

const PasteRepair = Extension.create({
  name: 'pasteRepair',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pasteRepair'),
        props: {
          transformPastedHTML: (html) => {
            try {
              return repairPastedHTML(html);
            } catch {
              // A parse failure must never block the paste itself.
              return html;
            }
          },
        },
      }),
    ];
  },
});

// -------------------------------------------------------------- pasted images

export interface EditorHooks {
  /** Surfaces a message through the app's toast, from inside a plugin. */
  onNotice?: (message: string, tone?: 'info' | 'danger') => void;
}

function imageFilesFrom(dt: DataTransfer): File[] {
  return [...(dt.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

async function storeAll(files: File[], hooks: EditorHooks): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    try {
      const rec = await storeImageFile(file);
      ids.push(rec.id);
    } catch (err) {
      hooks.onNotice?.(
        err instanceof ImageError ? err.message : 'That image could not be added.',
        'danger',
      );
    }
  }
  return ids;
}

/** Insert stored images at the current selection, each on its own block. */
function insertStored(view: EditorView, ids: string[], at?: number) {
  if (!ids.length) return;
  const { schema } = view.state;
  const nodes = ids.map((id) =>
    schema.nodes.image.create({ src: `${IDB_SCHEME}${id}`, alt: '', title: '' }),
  );
  const tr = view.state.tr;
  // One insert, not one per image: each `replaceSelectionWith` on the same
  // transaction would keep replacing at the original selection.
  const pos = at ?? tr.selection.from;
  tr.replaceWith(pos, at ?? tr.selection.to, nodes);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
}

async function dataUriToFile(uri: string, index: number): Promise<File | null> {
  try {
    // `fetch` on a data: URI is a synchronous decode, not a network request.
    const blob = await fetch(uri).then((r) => r.blob());
    const ext = (blob.type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/g, '');
    return new File([blob], `pasted-${index + 1}.${ext}`, { type: blob.type });
  } catch {
    return null;
  }
}

/**
 * Images pasted from Google Docs or Word arrive as `data:` URIs. The schema is
 * configured `allowBase64: false` — base64 in the document would bloat every
 * save, every revision and every future round-trip (ARCHITECTURE.md §2) — so
 * without this they were dropped silently and the paste lost the picture.
 * Store the bytes and rewrite to `idb:` instead: content preserved, no network,
 * and the same representation a locally uploaded image gets.
 */
async function rewriteDataImages(html: string, hooks: EditorHooks): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inline = [...doc.querySelectorAll('img')].filter((el) =>
    (el.getAttribute('src') ?? '').startsWith('data:'),
  );
  await Promise.all(
    inline.map(async (el, i) => {
      const file = await dataUriToFile(el.getAttribute('src') ?? '', i);
      const id = file ? (await storeAll([file], hooks))[0] : undefined;
      if (id) el.setAttribute('src', `${IDB_SCHEME}${id}`);
      else el.remove();
    }),
  );
  return doc.body.innerHTML;
}

/**
 * A remote `<img>` is kept — never lose content — but it breaks offline.
 *
 * THE STORED-IMAGE TEST IS EXPLICIT HERE EVEN THOUGH IT CHANGES NOTHING TODAY,
 * and the honest version of why: `protocolOf('asset:img_x')` already returns
 * `'asset:'`, which is not in `ALLOWED_IMAGE_PROTOCOLS`, so a stored image is
 * not counted as remote right now — measured, `countRemoteImages` over one
 * `asset:`, one `idb:` and one `http:` image returns 1. What this line buys is
 * that the exclusion no longer depends on that coincidence. Both `asset:` and
 * `idb:` DO name a protocol, so the day anything widens the render list — a
 * `blob:` preview, say — a stored image starts being badged "on another site"
 * and the writer is told to rescue a picture that is already local. Same
 * predicate as `stripHostile` and `ImageNode`, decided in one place.
 */
export function countRemoteImages(html: string): number {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('img')].filter((el) => {
      const src = el.getAttribute('src');
      return imageIdFromSrc(src) === null && isAllowedImageSrc(src);
    }).length;
  } catch {
    return 0;
  }
}

const REMOTE_NOTICE =
  'image still lives on another site. It will break if that site removes it — open it and choose “Save to this blog”.';

function createImagePaste(hooks: EditorHooks) {
  return new Plugin({
    key: new PluginKey('studioImagePaste'),
    props: {
      handlePaste: (view, event) => {
        const dt = (event as ClipboardEvent).clipboardData;
        if (!dt) return false;
        const html = dt.getData('text/html');
        const files = imageFilesFrom(dt);

        // A screenshot or a dragged file: no markup, just bytes.
        if (files.length && !html) {
          event.preventDefault();
          void storeAll(files, hooks).then((ids) => insertStored(view, ids));
          return true;
        }

        if (html && /<img[^>]+src\s*=\s*["']?\s*data:/i.test(html)) {
          event.preventDefault();
          void rewriteDataImages(html, hooks).then((rewritten) => {
            const remote = countRemoteImages(rewritten);
            // `pasteHTML` re-enters the paste pipeline, so transformPastedHTML
            // still runs and the repair rules apply exactly once.
            view.pasteHTML(rewritten);
            if (remote) {
              hooks.onNotice?.(
                `${remote} ${remote === 1 ? 'pasted image' : 'pasted images'} ${REMOTE_NOTICE}`,
              );
            }
          });
          return true;
        }

        if (html) {
          const remote = countRemoteImages(html);
          if (remote) {
            hooks.onNotice?.(
              `${remote} ${remote === 1 ? 'pasted image' : 'pasted images'} ${REMOTE_NOTICE}`,
            );
          }
        }
        return false;
      },

      handleDrop: (view, event, _slice, moved) => {
        // `moved` is an internal drag — reordering a block, not adding one.
        if (moved) return false;
        const dt = (event as DragEvent).dataTransfer;
        if (!dt) return false;
        const files = imageFilesFrom(dt);
        if (!files.length) return false;
        event.preventDefault();
        // Drop where the pointer is, not where the caret happened to be.
        const at = view.posAtCoords({
          left: (event as DragEvent).clientX,
          top: (event as DragEvent).clientY,
        });
        void storeAll(files, hooks).then((ids) => insertStored(view, ids, at?.pos));
        return true;
      },
    },
  });
}

const ImageDrop = Extension.create<EditorHooks>({
  name: 'studioImagePaste',
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    return [createImagePaste(this.options)];
  },
});

// ------------------------------------------------------------- moving a block

/**
 * Alt+↑/↓ moves the block the caret is in. The pointer affordance (the drag
 * handle) is the discoverable route; this is the one that works without a
 * mouse, and it is the only route on a block a hover never reaches.
 */
const LIST_ITEMS = new Set(['listItem', 'taskItem']);

const BlockMove = Extension.create({
  name: 'blockMove',
  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => () => {
      const { state, view } = this.editor;
      const { $from } = state.selection;

      // Move the nearest list item if the caret is inside a list, otherwise the
      // top-level block. Lifting a paragraph out of its list would change what
      // it means, which is not what "move down" asks for.
      let depth = $from.depth;
      while (depth > 1 && !LIST_ITEMS.has($from.node(depth).type.name)) depth -= 1;
      if (depth < 1) return false;

      const parent = $from.node(depth - 1);
      const swap = $from.index(depth - 1) + dir;
      if (swap < 0 || swap >= parent.childCount) return false;

      const node = $from.node(depth);
      const from = $from.before(depth);
      const sibling = parent.child(swap);
      // Deleting first shifts everything after `from` left by the node's size,
      // so a downward move lands one sibling further on and an upward move
      // lands one sibling back — the sibling before us is untouched either way.
      const landed = dir === 1 ? from + sibling.nodeSize : from - sibling.nodeSize;
      const caretOffset = state.selection.from - from;

      const tr = state.tr.delete(from, from + node.nodeSize).insert(landed, node);
      tr.setSelection(
        Selection.near(tr.doc.resolve(Math.min(landed + caretOffset, tr.doc.content.size))),
      );
      view.dispatch(tr.scrollIntoView());
      return true;
    };
    return { 'Alt-ArrowUp': move(-1), 'Alt-ArrowDown': move(1) };
  },
});

// ------------------------------------------------------------ slash command

export interface SlashState {
  active: boolean;
  /** Document position of the `/` itself, so it can be replaced on pick. */
  from: number;
  query: string;
}

export const slashKey = new PluginKey<SlashState>('slashCommand');

const IDLE: SlashState = { active: false, from: 0, query: '' };

/**
 * `/` opens the same palette the `+` does. Tracked as plugin state rather than
 * as component state because only the document knows whether the `/` is still
 * there — undo, a click elsewhere, or deleting back past it must all close it,
 * and none of those are events a React handler sees.
 */
const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => IDLE,
          apply(tr) {
            if (tr.getMeta(slashKey) === 'close') return IDLE;

            const { $from, empty } = tr.selection;
            if (!empty || $from.depth !== 1) return IDLE;
            const parent = $from.parent;
            if (parent.type.name !== 'paragraph' && parent.type.name !== 'heading') return IDLE;

            const text = parent.textBetween(0, $from.parentOffset, undefined, '￼');
            // Only from the very start of the block, and a space ends it: after
            // "/ " the writer meant a slash, not a command. Derived from the
            // document rather than from keystrokes so undo, a click elsewhere
            // and deleting back past the `/` all close it for free.
            if (!text.startsWith('/') || /\s/.test(text)) return IDLE;
            return { active: true, from: $from.start(), query: text.slice(1) };
          },
        },
      }),
    ];
  },
});

// ------------------------------------------------------------------- assembly

export function createEditorExtensions(hooks: EditorHooks = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      // CodeBlockLowlight registers the same node name, so StarterKit's plain
      // one has to stand down or the two collide at schema build.
      codeBlock: false,
      blockquote: { HTMLAttributes: { class: 'doc-quote' } },
      horizontalRule: { HTMLAttributes: { class: 'doc-rule' } },
      link: false,
      underline: false,
    }),
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: 'plaintext',
      // Re-applied here because StarterKit's codeBlock is off: every .doc-code
      // rule in prose.css keys off this class, on both surfaces.
      HTMLAttributes: { class: 'doc-code' },
    }),
    TableKit.configure({
      table: { resizable: true, HTMLAttributes: { class: 'doc-table' } },
      tableHeader: { HTMLAttributes: { class: 'doc-th' } },
      tableCell: { HTMLAttributes: { class: 'doc-td' } },
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', class: 'doc-link' },
      // TipTap's `protocols` option only *appends* to a hardcoded baseline that
      // already allows tel/ftp/xmpp/sms, so it restricted nothing and the
      // editor accepted links the reader silently stripped. This is the real
      // gate, and it is the same predicate DocRenderer uses.
      isAllowedUri: (url, { defaultValidate }) => {
        if (!defaultValidate(url)) return false;
        // A bare `example.com` has no protocol yet — defaultProtocol adds one.
        return !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || isAllowedHref(url);
      },
    }),
    StudioImage.configure({
      inline: false,
      allowBase64: false,
      HTMLAttributes: { class: 'doc-image' },
    }),
    TaskList.configure({ HTMLAttributes: { class: 'doc-tasks' } }),
    TaskItem.configure({ nested: true }),
    CharacterCount,
    PasteRepair,
    ImageDrop.configure(hooks),
    BlockMove,
    SlashCommand,
    Placeholder.configure({
      placeholder: ({ node }) => {
        if (node.type.name === 'heading') return 'Heading';
        return 'Tell your story…';
      },
      showOnlyWhenEditable: true,
      includeChildren: false,
    }),
  ];
}

/** Schema-only default, used by tests and by anything that just needs shapes. */
export const editorExtensions = createEditorExtensions();
