/**
 * The size ceilings, and the one property that matters about them: the
 * validator must refuse a document BEFORE the database physically can.
 *
 * `MAX_DOC_BYTES` alone did not give that. A `tsvector` cannot exceed
 * MAXSTRPOS = 1 048 575 bytes of lexemes and positions, so a high-diversity
 * document well under the 2 MB serialised ceiling of spec §4.6 was accepted
 * here and then rejected by Postgres with SQLSTATE 54000 — a code spec §8 has
 * no row for, on an UPDATE that leaves the existing row readable and
 * permanently unwritable.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MARKS,
  ALLOWED_NODES,
  MAX_CONTENT_TEXT_BYTES,
  MAX_DOC_BYTES,
  MAX_DOC_DEPTH,
  MAX_DOC_NODES,
  checkDocSize,
  utf8Bytes,
  validateDoc,
} from './validate';
import { docToText } from './doc';
import type { DocNode } from './types';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** `k` distinct terms — the shape that defeats lexeme deduplication. */
const glossary = (k: number) => Array.from({ length: k }, (_, i) => `term${i}`).join(' ');

describe('document size ceilings', () => {
  it('accepts an ordinary document', () => {
    expect(checkDocSize(doc('Hello world.'))).toBeNull();
  });

  it('accepts a large document whose body text is under the derived-text ceiling', () => {
    // 2 MB of ordinary prose is fine — this is not a "long posts are banned"
    // rule. Lexemes dedupe, so an eight-word vocabulary repeated to 2 MB is a
    // 1 572-byte tsvector.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    let prose = '';
    while (prose.length < MAX_CONTENT_TEXT_BYTES - 5_000) {
      prose += `${words[prose.length % 8]} `;
    }
    const value = doc(prose);
    expect(utf8Bytes(docToText(value))).toBeLessThan(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(value)).toBeNull();
  });

  it('rejects a document over the serialised ceiling', () => {
    // One long run of one repeated character: huge serialised, trivial tsvector.
    const value = doc('x'.repeat(MAX_DOC_BYTES + 1));
    expect(checkDocSize(value)).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('rejects the high-diversity document the database cannot store', () => {
    // 80 000 distinct terms, 788 889 bytes. Spec-legal by the serialised
    // ceiling; SQLSTATE 54000 at the database. This is the case that was
    // accepted here and unwritable there.
    const body = glossary(80_000);
    expect(utf8Bytes(body)).toBeLessThan(MAX_DOC_BYTES);
    expect(utf8Bytes(body)).toBeGreaterThan(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(doc(body))).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('measures the derived text, not the serialised document', () => {
    // The two ceilings are independent: a document can be small serialised and
    // over the derived-text line, or the reverse. Checking only `MAX_DOC_BYTES`
    // is what let the 54000 through.
    const body = glossary(80_000);
    const value = doc(body);
    expect(utf8Bytes(JSON.stringify(value))).toBeLessThan(MAX_DOC_BYTES);
    expect(checkDocSize(value)).not.toBeNull();
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // `String.length` undercounts by up to 3x, so a character ceiling bounds
    // nothing for multibyte text — 600 000 CJK characters are 1.4 MB and still
    // raise 54000. This is why the constant is a byte count.
    const cjk = '漢'.repeat(200_000);
    expect(cjk.length).toBeLessThan(MAX_CONTENT_TEXT_BYTES);
    expect(utf8Bytes(cjk)).toBe(600_000);
    expect(checkDocSize(doc(cjk))).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('sits below the ceiling exactly at the ceiling', () => {
    const body = 'a'.repeat(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(doc(body))).toBeNull();
    expect(checkDocSize(doc(`${body}bb`))).toEqual({
      path: 'content',
      reason: 'too_large',
    });
  });

  it('refuses a value it cannot serialise rather than guessing', () => {
    const circular: Record<string, unknown> = { type: 'doc', content: [] };
    circular.self = circular;
    expect(checkDocSize(circular)).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('leaves non-document values to Task 4, which reports them as malformed', () => {
    expect(checkDocSize(null)).toBeNull();
    expect(checkDocSize({ type: 'paragraph' })).toBeNull();
  });

  it('the derived-text ceiling is strictly under the serialised one', () => {
    // If it ever crept above, the derived check would be unreachable and the
    // 54000 would be back.
    expect(MAX_CONTENT_TEXT_BYTES).toBeLessThan(MAX_DOC_BYTES);
    // Pinned, not incidental: this number is also the `CASE` threshold in
    // `server/db/migrations/0001_bound_search_input.sql`, and the margin it
    // buys is measured — the worst of twelve adversarial shapes at this size
    // produced a 808 580-byte lexeme area against a 1 048 575-byte limit.
    expect(MAX_CONTENT_TEXT_BYTES).toBe(500_000);
    expect(MAX_DOC_BYTES).toBe(2 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------- validateDoc

/** A document whose root children are exactly the nodes given. */
const wrap = (...content: unknown[]): unknown => ({ type: 'doc', content });

const para = (text = 'hello'): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const marked = (mark: unknown): unknown =>
  wrap({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [mark] }] });

const image = (src: unknown): unknown => wrap({ type: 'image', attrs: { src } });

function nest(depth: number): unknown {
  const root: DocNode = { type: 'doc', content: [] };
  let cur = root;
  for (let i = 0; i < depth; i += 1) {
    const next: DocNode = { type: 'blockquote', content: [] };
    cur.content!.push(next);
    cur = next;
  }
  return root;
}

function violation(value: unknown) {
  const result = validateDoc(value);
  return result.ok ? null : result.violation;
}

describe('validateDoc', () => {
  it('accepts a plain paragraph', () => {
    const value = wrap(para());
    const result = validateDoc(value);
    expect(result).toEqual({ ok: true, doc: value });
  });

  it('accepts every node type the editor can produce', () => {
    // Not a restatement of the constant: each entry here is a shape the live
    // editor emits, so a node the schema gained but the allow-list did not
    // fails here rather than silently 422-ing a writer's post.
    const shapes: Record<string, unknown> = {
      paragraph: para(),
      heading: { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      blockquote: { type: 'blockquote', content: [para()] },
      bulletList: { type: 'bulletList', content: [{ type: 'listItem', content: [para()] }] },
      orderedList: { type: 'orderedList', content: [{ type: 'listItem', content: [para()] }] },
      listItem: { type: 'bulletList', content: [{ type: 'listItem', content: [para()] }] },
      taskList: {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [para()] }],
      },
      taskItem: {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [para()] }],
      },
      codeBlock: {
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'const a = 1;' }],
      },
      horizontalRule: { type: 'horizontalRule' },
      hardBreak: { type: 'paragraph', content: [{ type: 'hardBreak' }] },
      image: { type: 'image', attrs: { src: 'idb:img_1', alt: '', title: '' } },
      // TableKit is in `createEditorExtensions()`, and DocRenderer has real
      // arms for all four. The plan's list predates the table work.
      table: {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [para()] },
              { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [para()] },
            ],
          },
        ],
      },
      tableRow: { type: 'table', content: [{ type: 'tableRow', content: [] }] },
      tableHeader: {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [para()] }] }],
      },
      tableCell: {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para()] }] }],
      },
    };

    for (const type of ALLOWED_NODES) {
      if (type === 'doc' || type === 'text') continue;
      expect(shapes[type], `no fixture for node type ${type}`).toBeDefined();
      expect(violation(wrap(shapes[type]))).toBeNull();
    }
  });

  it('accepts every mark the editor can produce', () => {
    const attrs: Record<string, unknown> = { link: { href: 'https://example.com' } };
    for (const type of ALLOWED_MARKS) {
      expect(violation(marked({ type, attrs: attrs[type] }))).toBeNull();
    }
  });

  it('rejects an unknown node type', () => {
    expect(violation(wrap({ type: 'script', content: [] }))).toEqual({
      path: 'content[0]',
      reason: 'unknown_node',
    });
  });

  it('rejects an unknown mark type', () => {
    expect(violation(marked({ type: 'highlight' }))).toEqual({
      path: 'content[0].content[0].marks[0]',
      reason: 'unknown_mark',
    });
  });

  it('rejects a javascript: href', () => {
    expect(violation(marked({ type: 'link', attrs: { href: 'javascript:alert(1)' } }))).toEqual({
      path: 'content[0].content[0].marks[0]',
      reason: 'bad_protocol',
    });
  });

  it('rejects a href that hides its protocol behind whitespace or a control character', () => {
    for (const href of [' javascript:alert(1)', 'java\nscript:alert(1)', 'JavaScript:alert(1)']) {
      expect(violation(marked({ type: 'link', attrs: { href } }))?.reason).toBe('bad_protocol');
    }
  });

  it('rejects a data: image src', () => {
    expect(violation(image('data:image/png;base64,AAAA'))).toEqual({
      path: 'content[0]',
      reason: 'bad_protocol',
    });
  });

  it('accepts asset:, idb: and https: image srcs', () => {
    for (const src of ['asset:img_1', 'idb:img_1', 'https://cdn.example.com/a.png']) {
      expect(violation(image(src))).toBeNull();
    }
  });

  it('refuses an http: image src, which the client-side render guard still allows', () => {
    // Spec §4.6 lists {https, asset:, idb:} — http is deliberately absent. The
    // editor's own `isAllowedImageSrc` accepts http today, so a pasted
    // `http://…` image is producible on the client and refused here. Pinned so
    // the divergence is a decision someone made, not one nobody noticed.
    expect(violation(image('http://cdn.example.com/a.png'))).toEqual({
      path: 'content[0]',
      reason: 'bad_protocol',
    });
  });

  it('rejects nesting deeper than the cap without overflowing the stack', () => {
    // 10 000 levels. A recursive walk throws RangeError here — and so does
    // `JSON.stringify`, measured to give up at ~2 389 — so the size check must
    // not turn an unmeasurable document into a wrong answer either.
    expect(violation(nest(10_000))).toEqual({
      path: expect.stringContaining(`content[0]`),
      reason: 'too_deep',
    });
    expect(violation(nest(MAX_DOC_DEPTH + 1))?.reason).toBe('too_deep');
    expect(violation(nest(MAX_DOC_DEPTH - 1))).toBeNull();
  });

  it('rejects a document over the byte cap before walking it', () => {
    // Over the ceiling AND structurally invalid at the first child. The size
    // answer proves the walk never ran: a hostile payload cannot buy a full
    // traversal.
    const value = wrap({ type: 'script' }, para('x'.repeat(MAX_DOC_BYTES)));
    expect(violation(value)).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('rejects a document over the node cap', () => {
    const value = wrap(...Array.from({ length: MAX_DOC_NODES + 5 }, () => ({ type: 'horizontalRule' })));
    expect(violation(value)?.reason).toBe('too_many_nodes');
  });

  it('rejects a document whose derived text exceeds the search-index ceiling', () => {
    const body = Array.from({ length: 80_000 }, (_, i) => `term${i}`).join(' ');
    expect(violation(wrap(para(body)))).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('reports the path of the offending node', () => {
    expect(violation(wrap(para(), { type: 'marquee' }))).toEqual({
      path: 'content[1]',
      reason: 'unknown_node',
    });
    expect(
      violation(wrap(para(), { type: 'blockquote', content: [para(), { type: 'marquee' }] })),
    ).toEqual({ path: 'content[1].content[1]', reason: 'unknown_node' });
  });

  it('rejects anything that is not a document', () => {
    for (const value of [null, undefined, 'doc', 42, [], { type: 'paragraph' }, { type: 'doc' }]) {
      expect(violation(value)).toEqual({ path: 'content', reason: 'malformed' });
    }
  });

  it('rejects a node whose shape is wrong rather than trusting it', () => {
    expect(violation(wrap('paragraph'))).toEqual({ path: 'content[0]', reason: 'malformed' });
    expect(violation(wrap({ type: 42 }))).toEqual({ path: 'content[0]', reason: 'malformed' });
    expect(violation(wrap({ type: 'paragraph', content: 'oops' }))).toEqual({
      path: 'content[0]',
      reason: 'malformed',
    });
    expect(violation(wrap({ type: 'paragraph', content: [{ type: 'text' }] }))).toEqual({
      path: 'content[0].content[0]',
      reason: 'malformed',
    });
    expect(violation(marked('bold'))).toEqual({
      path: 'content[0].content[0].marks[0]',
      reason: 'malformed',
    });
  });

  it('terminates on a circular document instead of spinning', () => {
    // Unreachable over HTTP — `JSON.parse` cannot build a cycle — but reachable
    // in-process, and an unbounded walk there is a hung request. Any cycle is
    // an infinitely deep document and the walk is depth-first, so the depth cap
    // is what stops it — 41 pops in, whatever the shape of the loop.
    const loop: Record<string, unknown> = { type: 'blockquote' };
    loop.content = [loop];
    expect(violation(wrap(loop))?.reason).toBe('too_deep');

    const a: Record<string, unknown> = { type: 'blockquote' };
    const b: Record<string, unknown> = { type: 'blockquote', content: [a] };
    a.content = [b];
    expect(violation(wrap(a))?.reason).toBe('too_deep');
  });

  it('the allow-lists are the ones the editor produces, and nothing else', () => {
    // Provenance, not decoration: StarterKit (headings 2-3, link and underline
    // off) + CodeBlockLowlight + TableKit + Underline + Link + StudioImage +
    // TaskList/TaskItem. `doc` is here and is NOT a DocRenderer case — the root
    // is handled by the walk, so transcribing the renderer's `switch` would
    // reject every valid document.
    expect([...ALLOWED_NODES].sort()).toEqual(
      [
        'blockquote', 'bulletList', 'codeBlock', 'doc', 'hardBreak', 'heading',
        'horizontalRule', 'image', 'listItem', 'orderedList', 'paragraph',
        'table', 'tableCell', 'tableHeader', 'tableRow', 'taskItem', 'taskList',
        'text',
      ].sort(),
    );
    expect([...ALLOWED_MARKS].sort()).toEqual(
      ['bold', 'code', 'italic', 'link', 'strike', 'underline'].sort(),
    );
  });
});
