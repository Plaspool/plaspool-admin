/**
 * The document ⇄ HTML codec that makes a CSV round trip lossless.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY: THE CSV EXPORT USED TO CARRY `description_text` AND FLATTEN EVERY
 * DESCRIPTION IT TOUCHED.
 *
 * The old `Description` column held `docToText` output — plain text with the
 * block boundaries already collapsed to single spaces — and the import wrapped
 * that text in ONE paragraph. Export → import therefore destroyed every
 * heading, list and bold run in the catalogue, and it did so on 2026-09-04 to
 * two live products. `scripts/restore-description-revision.ts` is the repair;
 * this file is the reason it cannot happen again.
 *
 * HTML rather than the raw document JSON, for two reasons. It is what Shopify's
 * `Body (HTML)` column carries, and this format already aims to be importable
 * from a Shopify-shaped file. And a person can read and edit `<h2>Key
 * Features</h2><ul><li>…` in a spreadsheet cell, which is the entire point of
 * exporting to a spreadsheet — the JSON of a ProseMirror document is not
 * something anyone edits by hand.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO DEPENDENCY, AND NO DOM. `@tiptap/html` would be the obvious tool and is
 * the wrong one here: it needs a server DOM (`zeed-dom`/jsdom — jsdom is a
 * devDependency and is not in the deployed bundle) and it drags the whole
 * editor extension graph, React node views included, into a serverless
 * function. `server/shop/catalog/csv.ts` already carries a long comment about
 * what a CommonJS dependency did to this exact route under Node's ESM loader;
 * the cheapest way not to repeat it is to add no dependency at all. This is
 * string in, string out.
 *
 * THE ROUND-TRIP CONTRACT, pinned by `doc-html.test.ts`:
 *
 *   htmlToDoc(docToHtml(doc))  ==  normaliseDoc(doc)
 *
 * Exact equality up to two normalisations that carry no meaning: an attribute
 * whose value is `null` is dropped (TipTap writes `{href, target: null, rel:
 * null, class: null}` for a plain link, and all four render identically), and
 * an empty `content: []` is dropped (ProseMirror's own omission). Everything
 * else — every node type in `ALLOWED_NODES`, every mark in `ALLOWED_MARKS`,
 * every attribute in the validator's tables — survives byte for byte.
 *
 * The import leans on something stronger still: it compares the cell against
 * `docToHtml(stored)` and writes NOTHING when they match, so an unedited round
 * trip cannot touch a description whatever this codec does. See `csv.ts`.
 */
import type { DocNode } from './types';

// ------------------------------------------------------------------ escaping

/** Text-node escaping. `&` first, or the others' entities get double-escaped. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Attribute-value escaping. Values are always emitted in double quotes. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * The five XML entities plus the numeric forms, which is everything this
 * codec emits and the overwhelming majority of what a hand-written or
 * Shopify-exported cell contains. An unrecognised entity is left ALONE rather
 * than mangled — `&pound;` surviving as literal text is a smaller loss than
 * `&pound;` becoming an empty string, and a full entity table is 2 000 names
 * for a case this format has never seen.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // U+00A0, not a plain space: collapsing it would silently rewrite the
  // deliberate non-breaking spaces in copy like '190-240 °C'.
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points would throw; keep the source.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// --------------------------------------------------------------- serialising

/** Tags with no end tag and no children. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img']);

/**
 * `attrs` in the order the validator lists them, skipping `null`/`undefined`.
 * A `colwidth` array is joined with commas — it is the one attribute in the
 * schema whose value is not a scalar, and `[100,200]` in an HTML attribute has
 * no other honest spelling.
 */
function attrsToHtml(attrs: Record<string, unknown> | undefined, names: readonly string[]): string {
  if (!attrs) return '';
  let out = '';
  for (const name of names) {
    const value = attrs[name];
    if (value === null || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    out += ` ${name}="${escapeAttr(text)}"`;
  }
  return out;
}

/** The mark type → tag mapping, applied outermost-first so the tags nest in a
 *  stable order and the round trip does not reshuffle them. */
const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  link: 'a',
};

const LINK_ATTRS = ['href', 'target', 'rel', 'class', 'title'] as const;

/**
 * A text node or a hard break, wrapped in its marks.
 *
 * A `hardBreak` CAN CARRY MARKS — ProseMirror's is `marks: "_"` — and
 * production has a heading beginning `{hardBreak, marks:[bold]}`. Returning
 * `<br>` before the mark loop dropped that mark and made the round trip lossy
 * on a real document, which the unit fixtures never showed because nobody
 * writes a bolded line break on purpose. Found by running every stored
 * revision through the codec.
 */
function inlineToHtml(node: DocNode): string {
  if (node.type !== 'text' && node.type !== 'hardBreak') return nodeToHtml(node);

  let html = node.type === 'hardBreak' ? '<br>' : escapeText(node.text ?? '');
  // Innermost mark first, so `marks: [bold, italic]` emits <strong><em>.
  for (let i = (node.marks?.length ?? 0) - 1; i >= 0; i -= 1) {
    const mark = node.marks![i]!;
    const tag = MARK_TAGS[mark.type];
    if (tag === undefined) continue; // Unknown mark: keep the text, drop the tag.
    const attrs = mark.type === 'link' ? attrsToHtml(mark.attrs, LINK_ATTRS) : '';
    html = `<${tag}${attrs}>${html}</${tag}>`;
  }
  return html;
}

function childrenToHtml(node: DocNode): string {
  return (node.content ?? []).map(inlineToHtml).join('');
}

const CELL_ATTRS = ['colspan', 'rowspan', 'colwidth', 'align'] as const;

/**
 * One node to HTML. NO WHITESPACE IS EMITTED BETWEEN TAGS — not a newline, not
 * an indent. Pretty-printing here would put whitespace text nodes into every
 * document that came back through `htmlToDoc`, and a CSV cell wants one line
 * anyway.
 *
 * EVERY TYPE IN `ALLOWED_NODES` HAS AN ARM. `doc-html.test.ts` walks that set
 * and fails on a type this switch does not name, so an extension added to the
 * editor cannot start silently dropping content from exports.
 */
function nodeToHtml(node: DocNode): string {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).map(nodeToHtml).join('');
    case 'text':
      return inlineToHtml(node);
    case 'paragraph':
      return `<p>${childrenToHtml(node)}</p>`;
    case 'heading': {
      const level = Number(node.attrs?.level);
      const tag = `h${Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2}`;
      return `<${tag}>${childrenToHtml(node)}</${tag}>`;
    }
    case 'blockquote':
      return `<blockquote>${(node.content ?? []).map(nodeToHtml).join('')}</blockquote>`;
    case 'bulletList':
      return `<ul>${(node.content ?? []).map(nodeToHtml).join('')}</ul>`;
    case 'orderedList':
      return `<ol${attrsToHtml(node.attrs, ['start', 'type'])}>${(node.content ?? [])
        .map(nodeToHtml)
        .join('')}</ol>`;
    case 'listItem':
      return `<li>${(node.content ?? []).map(nodeToHtml).join('')}</li>`;
    /*
     * `data-type` on both, exactly as `DocRenderer` emits it and as TipTap's own
     * serialisation expects — it is the ONLY thing distinguishing a checklist
     * from a bullet list in HTML, so without it a round trip silently demotes
     * every task list.
     */
    case 'taskList':
      return `<ul data-type="taskList">${(node.content ?? []).map(nodeToHtml).join('')}</ul>`;
    case 'taskItem':
      return `<li data-type="taskItem" data-checked="${node.attrs?.checked ? 'true' : 'false'}">${(
        node.content ?? []
      )
        .map(nodeToHtml)
        .join('')}</li>`;
    case 'codeBlock': {
      const language = node.attrs?.language;
      const cls = language == null || language === '' ? '' : ` class="language-${escapeAttr(String(language))}"`;
      return `<pre><code${cls}>${escapeText(childrenText(node))}</code></pre>`;
    }
    case 'horizontalRule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'image':
      return `<img${attrsToHtml(node.attrs, ['src', 'alt', 'title', 'width', 'height'])}>`;
    case 'table':
      return `<table>${(node.content ?? []).map(nodeToHtml).join('')}</table>`;
    case 'tableRow':
      return `<tr>${(node.content ?? []).map(nodeToHtml).join('')}</tr>`;
    case 'tableHeader':
      return `<th${attrsToHtml(node.attrs, CELL_ATTRS)}>${(node.content ?? [])
        .map(nodeToHtml)
        .join('')}</th>`;
    case 'tableCell':
      return `<td${attrsToHtml(node.attrs, CELL_ATTRS)}>${(node.content ?? [])
        .map(nodeToHtml)
        .join('')}</td>`;
    default:
      /*
       * An unknown node keeps its TEXT and loses its markup — the same
       * conservative choice `DocRenderer` makes for a type not on its list.
       * Dropping the node entirely would lose words; emitting its tag would
       * mean this codec inventing markup the schema never allowed.
       */
      return escapeText(childrenText(node));
  }
}

/** Concatenated text of a subtree, no separators — for code blocks, whose
 *  content is literal text including its newlines. */
function childrenText(node: DocNode): string {
  let out = '';
  const walk = (n: DocNode): void => {
    if (typeof n.text === 'string') out += n.text;
    for (const child of n.content ?? []) walk(child);
  };
  for (const child of node.content ?? []) walk(child);
  return out;
}

/** A document as one line of HTML. An empty or absent document is `''`. */
export function docToHtml(doc: DocNode | null | undefined): string {
  if (!doc) return '';
  return nodeToHtml(doc.type === 'doc' ? doc : { type: 'doc', content: [doc] });
}

// ------------------------------------------------------------------- parsing

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = Element | { text: string };

const isText = (node: Node): node is { text: string } => 'text' in node;

/**
 * Tags that close themselves when the next one opens, because HTML lets an
 * author omit their end tag. Without this a hand-written `<p>a<p>b` nests the
 * second paragraph inside the first and the round trip changes the structure.
 */
const AUTO_CLOSE: Record<string, ReadonlySet<string>> = {
  p: new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'table']),
  li: new Set(['li']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  tr: new Set(['tr']),
};

/**
 * A tolerant tokenizer over the small HTML this format ever sees: our own
 * output, a Shopify `Body (HTML)` cell, or something a person typed. Comments
 * and doctypes are skipped, a stray `<` that begins nothing is literal text,
 * and an unclosed tag closes at the end of input.
 *
 * `<pre>` IS RAW. Everything between it and its end tag is one text node with
 * its whitespace intact, because a code block's newlines are its content — a
 * tokenizer that trimmed them would silently reformat every code sample.
 */
function parseHtml(html: string): Node[] {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = (): Element => stack[stack.length - 1]!;
  let i = 0;

  const pushText = (raw: string): void => {
    if (raw === '') return;
    top().children.push({ text: decodeEntities(raw) });
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    /*
     * A `<` NOT FOLLOWED BY A TAG NAME, `/`, `!` OR `?` IS LITERAL TEXT. Copy
     * says "keep the bed < 60 °C" often enough to matter, and without this the
     * scan would take `< 60 °C</p>` for a tag, fail to name it, and swallow
     * the paragraph's own end tag along with it.
     */
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      pushText('<');
      i = lt + 1;
      continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt === -1) {
      // A `<` with no `>` after it is text, not a tag.
      pushText(html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().toLowerCase();
      // Close the nearest matching ancestor; ignore an end tag that opened nothing.
      const at = [...stack].reverse().findIndex((el) => el.tag === tag);
      if (at !== -1) stack.length = stack.length - 1 - at;
      i = gt + 1;
      continue;
    }

    const match = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!match) {
      pushText(html.slice(lt, gt + 1));
      i = gt + 1;
      continue;
    }
    const tag = match[1]!.toLowerCase();
    const el: Element = { tag, attrs: parseAttrs(raw.slice(match[1]!.length)), children: [] };

    const closes = AUTO_CLOSE[top().tag];
    if (closes?.has(tag)) stack.pop();

    top().children.push(el);
    i = gt + 1;

    if (VOID_TAGS.has(tag) || raw.endsWith('/')) continue;

    if (tag === 'pre') {
      const end = html.toLowerCase().indexOf('</pre>', i);
      const body = html.slice(i, end === -1 ? html.length : end);
      // Re-tokenize the inside so a `<code class=…>` wrapper is still seen,
      // but with its text kept verbatim: nothing below trims a `pre` subtree.
      el.children = parseHtml(body);
      i = end === -1 ? html.length : end + 6;
      continue;
    }

    stack.push(el);
  }

  return root.children;
}

/** `href="x" target='y' disabled` — quoted, single-quoted and bare forms. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] === '/') continue;
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// ----------------------------------------------------------- tree → document

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
  'pre', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img',
]);

const MARK_BY_TAG: Record<string, string> = {
  strong: 'bold', b: 'bold',
  em: 'italic', i: 'italic',
  u: 'underline',
  s: 'strike', strike: 'strike', del: 'strike',
  code: 'code',
  a: 'link',
};

function numberAttr(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Only the names the validator allows for this type, and only when present —
 *  so a stray `style=` or `onclick=` in a pasted cell never reaches the
 *  document, and an absent attribute stays absent rather than becoming null. */
function pickAttrs(
  source: Record<string, string>,
  spec: { name: string; kind: 'string' | 'number' | 'numbers' | 'boolean' }[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const { name, kind } of spec) {
    const raw = source[name];
    if (raw === undefined) continue;
    if (kind === 'number') {
      const n = numberAttr(raw);
      if (n !== undefined) out[name] = n;
    } else if (kind === 'numbers') {
      const list = raw.split(',').map((part) => Number(part.trim())).filter((n) => Number.isFinite(n));
      if (list.length > 0) out[name] = list;
    } else if (kind === 'boolean') {
      out[name] = raw === 'true' || raw === '';
    } else if (raw !== '') {
      out[name] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const CELL_SPEC = [
  { name: 'colspan', kind: 'number' as const },
  { name: 'rowspan', kind: 'number' as const },
  { name: 'colwidth', kind: 'numbers' as const },
  { name: 'align', kind: 'string' as const },
];

/** `content` omitted rather than `[]`, matching what ProseMirror stores. */
function withContent(node: DocNode, content: DocNode[]): DocNode {
  return content.length > 0 ? { ...node, content } : node;
}

type Mark = { type: string; attrs?: Record<string, unknown> };

/**
 * Inline children, accumulating marks on the way down.
 *
 * ADJACENT TEXT NODES CARRYING THE SAME MARKS ARE MERGED, because ProseMirror
 * never stores two of them side by side — it is not a cosmetic difference, it
 * is the difference between a document the editor would produce and one it
 * would immediately rewrite, which would make every round trip report a change
 * that nobody made. `<span>` unwrapping and a literal `<` both produce the
 * split that this closes.
 */
function toInline(nodes: Node[], marks: Mark[]): DocNode[] {
  const out: DocNode[] = [];
  const push = (node: DocNode): void => {
    const last = out[out.length - 1];
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      JSON.stringify(last.marks ?? null) === JSON.stringify(node.marks ?? null)
    ) {
      last.text = (last.text ?? '') + (node.text ?? '');
      return;
    }
    out.push(node);
  };
  for (const node of nodes) {
    if (isText(node)) {
      if (node.text === '') continue;
      push(marks.length > 0 ? { type: 'text', marks, text: node.text } : { type: 'text', text: node.text });
      continue;
    }
    if (node.tag === 'br') {
      push(marks.length > 0 ? { type: 'hardBreak', marks } : { type: 'hardBreak' });
      continue;
    }
    const markType = MARK_BY_TAG[node.tag];
    if (markType !== undefined) {
      const attrs = markType === 'link'
        ? pickAttrs(node.attrs, LINK_ATTRS.map((name) => ({ name, kind: 'string' as const })))
        : undefined;
      const mark: Mark = attrs ? { type: markType, attrs } : { type: markType };
      // Deeper of the same type wins nothing — a mark set carries each once.
      const next = marks.some((m) => m.type === markType) ? marks : [...marks, mark];
      for (const child of toInline(node.children, next)) push(child);
      continue;
    }
    // Any other inline wrapper (span, font, a nested block in a bad cell) is
    // transparent: its text survives with the marks already gathered.
    for (const child of toInline(node.children, marks)) push(child);
  }
  return out;
}

/** Concatenated raw text of a subtree, whitespace untouched — code blocks. */
function rawText(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) out += isText(node) ? node.text : rawText(node.children);
  return out;
}

function toBlocks(nodes: Node[]): DocNode[] {
  const out: DocNode[] = [];
  /* Loose inline content between blocks becomes a paragraph — which is also
   * what makes a cell of PLAIN TEXT (no tags at all) import correctly, and so
   * what keeps a Shopify-shaped file working. */
  let pending: Node[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const inline = toInline(pending, []);
    pending = [];
    // Whitespace-only runs are a file's indentation, not content.
    if (inline.some((n) => n.type !== 'text' || (n.text ?? '').trim() !== '')) {
      out.push({ type: 'paragraph', content: inline });
    }
  };

  for (const node of nodes) {
    if (isText(node) || !BLOCK_TAGS.has(node.tag)) {
      // A non-block element with block children (div, figure, section) is
      // transparent rather than dropped.
      if (!isText(node) && node.children.some((c) => !isText(c) && BLOCK_TAGS.has(c.tag))) {
        flush();
        out.push(...toBlocks(node.children));
        continue;
      }
      pending.push(node);
      continue;
    }
    flush();
    out.push(...blockToDoc(node));
  }
  flush();
  return out;
}

function blockToDoc(el: Element): DocNode[] {
  const { tag, attrs, children } = el;

  if (tag === 'p') return [withContent({ type: 'paragraph' }, toInline(children, []))];

  if (/^h[1-6]$/.test(tag)) {
    return [withContent({ type: 'heading', attrs: { level: Number(tag[1]) } }, toInline(children, []))];
  }

  if (tag === 'blockquote') return [withContent({ type: 'blockquote' }, toBlocks(children))];

  if (tag === 'ul') {
    // `data-type` is the only signal separating a checklist from a bullet list.
    const task = attrs['data-type'] === 'taskList';
    const items = children.filter((c): c is Element => !isText(c) && c.tag === 'li');
    return [
      withContent(
        { type: task ? 'taskList' : 'bulletList' },
        items.map((li) => listItemToDoc(li, task)),
      ),
    ];
  }

  if (tag === 'ol') {
    const items = children.filter((c): c is Element => !isText(c) && c.tag === 'li');
    const picked = pickAttrs(attrs, [
      { name: 'start', kind: 'number' },
      { name: 'type', kind: 'string' },
    ]);
    const node: DocNode = picked ? { type: 'orderedList', attrs: picked } : { type: 'orderedList' };
    return [withContent(node, items.map((li) => listItemToDoc(li, false)))];
  }

  if (tag === 'li') return [listItemToDoc(el, attrs['data-type'] === 'taskItem')];

  if (tag === 'pre') {
    const code = children.find((c): c is Element => !isText(c) && c.tag === 'code');
    const language = /language-([A-Za-z0-9+#._-]{1,32})/.exec(code?.attrs['class'] ?? '')?.[1];
    const text = rawText(code ? code.children : children);
    const node: DocNode = language ? { type: 'codeBlock', attrs: { language } } : { type: 'codeBlock' };
    return [text === '' ? node : { ...node, content: [{ type: 'text', text }] }];
  }

  if (tag === 'hr') return [{ type: 'horizontalRule' }];

  if (tag === 'img') {
    const picked = pickAttrs(attrs, [
      { name: 'src', kind: 'string' },
      { name: 'alt', kind: 'string' },
      { name: 'title', kind: 'string' },
      { name: 'width', kind: 'number' },
      { name: 'height', kind: 'number' },
    ]);
    return [picked ? { type: 'image', attrs: picked } : { type: 'image' }];
  }

  if (tag === 'table') {
    // thead/tbody/tfoot are not schema nodes: their rows belong to the table.
    const rows: Element[] = [];
    for (const child of children) {
      if (isText(child)) continue;
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        for (const inner of child.children) {
          if (!isText(inner) && inner.tag === 'tr') rows.push(inner);
        }
      }
    }
    return [withContent({ type: 'table' }, rows.map(rowToDoc))];
  }

  if (tag === 'tr') return [rowToDoc(el)];
  if (tag === 'th' || tag === 'td') return [cellToDoc(el)];

  return toBlocks(children);
}

function listItemToDoc(li: Element, task: boolean): DocNode {
  /*
   * The checklist node view renders `li > label(input + span) + div`, so the
   * words live in the `div` and the `label` is chrome. Dropping the label is
   * what stops a round trip from turning every task into the literal text of
   * its own checkbox.
   */
  const source = task
    ? li.children.filter((c) => isText(c) || c.tag !== 'label')
    : li.children;
  const blocks = toBlocks(source);
  // A bare `<li>text</li>` has inline content; the schema wants a block.
  const content = blocks.length > 0 ? blocks : [];
  if (!task) return withContent({ type: 'listItem' }, content);
  return withContent({ type: 'taskItem', attrs: { checked: li.attrs['data-checked'] === 'true' } }, content);
}

function rowToDoc(tr: Element): DocNode {
  const cells = tr.children.filter((c): c is Element => !isText(c) && (c.tag === 'th' || c.tag === 'td'));
  return withContent({ type: 'tableRow' }, cells.map(cellToDoc));
}

function cellToDoc(cell: Element): DocNode {
  const picked = pickAttrs(cell.attrs, CELL_SPEC);
  const type = cell.tag === 'th' ? 'tableHeader' : 'tableCell';
  const node: DocNode = picked ? { type, attrs: picked } : { type };
  return withContent(node, toBlocks(cell.children));
}

/**
 * HTML (or plain text) to a document. ALWAYS returns a valid `doc`: ProseMirror's
 * schema makes `doc` `block+`, so an empty result becomes a single empty
 * paragraph rather than `content: []`.
 *
 * That last rule is not cosmetic. `createProduct` used to store `{type:'doc',
 * content:[]}`, which is invalid, and hydrating it fired `onContentError` and
 * LOCKED the editor — every newly created product had an uneditable
 * description (CLAUDE.md §2). An importer that could write the same value would
 * reintroduce it a thousand rows at a time.
 */
export function htmlToDoc(html: string): DocNode {
  const blocks = toBlocks(parseHtml(html));
  return { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
}

/**
 * The document as this codec can represent it, and therefore the right-hand
 * side of the round-trip equality. Three normalisations, none of which changes
 * what a reader sees:
 *
 *  - an attribute whose value is `null` is dropped;
 *  - an empty `content: []` is dropped, matching ProseMirror's own omission;
 *  - an EMPTY DOCUMENT becomes a single empty paragraph, because `doc` is
 *    `block+` and `{type:'doc',content:[]}` is invalid — the exact value that
 *    locked the editor on every newly created product (CLAUDE.md §2).
 */
export function normaliseDoc(doc: DocNode): DocNode {
  const clean = (node: DocNode): DocNode => {
    const out: DocNode = { type: node.type };
    if (node.attrs) {
      const attrs: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(node.attrs)) {
        if (value !== null && value !== undefined) attrs[name] = value;
      }
      if (Object.keys(attrs).length > 0) out.attrs = attrs;
    }
    if (node.marks && node.marks.length > 0) {
      out.marks = node.marks.map((mark) => {
        const attrs: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(mark.attrs ?? {})) {
          if (value !== null && value !== undefined) attrs[name] = value;
        }
        return Object.keys(attrs).length > 0 ? { type: mark.type, attrs } : { type: mark.type };
      });
    }
    if (typeof node.text === 'string') out.text = node.text;
    if (node.content && node.content.length > 0) out.content = node.content.map(clean);
    return out;
  };
  const cleaned = clean(doc);
  if (cleaned.type === 'doc' && (cleaned.content?.length ?? 0) === 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  return cleaned;
}
