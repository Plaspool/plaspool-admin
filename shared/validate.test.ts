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
  ALLOWED_LINK_PROTOCOLS,
  MAX_CATEGORY_BYTES,
  MAX_CONTENT_TEXT_BYTES,
  MAX_DOC_BYTES,
  MAX_DOC_DEPTH,
  MAX_DOC_NODES,
  MAX_EXCERPT_BYTES,
  MAX_SUBTITLE_BYTES,
  MAX_TAGS,
  MAX_TAG_BYTES,
  MAX_TITLE_BYTES,
  checkDocSize,
  checkPostMeta,
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
    /*
     * THIS IS LOAD-BEARING NOW IN A WAY IT WAS NOT BEFORE. A href that names no
     * scheme is ACCEPTED (see below), so "the scheme regex did not match" can no
     * longer mean "reject" — without stripping the invisibles first,
     * `java\nscript:alert(1)` would be waved through as if it were `/about`.
     */
    for (const href of [
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'java script:alert(1)',
      ' javascript:alert(1)',
      'jav ascript:alert(1)',
    ]) {
      expect(violation(marked({ type: 'link', attrs: { href } }))?.reason).toBe('bad_protocol');
    }
  });

  it('accepts the scheme-less hrefs the editor writes', () => {
    /*
     * THE DEFECT THIS PINS. `ALLOWED_LINK_PROTOCOLS` required a scheme match and
     * `protocolOf` returns null for anything not starting `scheme:`, so a
     * footnote anchor, a root-relative path, a protocol-relative URL and a
     * query-only href were all `bad_protocol`. `savePost` validates
     * `patch.content` on EVERY save, so one such link made every subsequent save
     * 422 — and spec §8 makes 422 a permanent stop in the client's retry policy,
     * so the pending write is dropped rather than retried and the writer keeps
     * typing into a post that can never be persisted.
     *
     * The editor half of this is pinned against a live `Editor` in
     * `src/editor/schema-drift.test.tsx`, which is what stops the two drifting
     * apart again.
     */
    for (const href of [
      '#notes',
      '/about',
      '//cdn.example/x',
      '?ref=1',
      'archive/2026',
      'page.html',
      '',
    ]) {
      expect(violation(marked({ type: 'link', attrs: { href } })), href).toBeNull();
    }
  });

  it('accepts a link mark with no href, which is inert rather than hostile', () => {
    // `Link`'s `href` attribute defaults to `null` and `setMark('link', {})`
    // leaves exactly that in the document — verified against a real Editor. A
    // document holding one would have been unsavable forever, which is the same
    // defect as refusing `#fn1`. `DocRenderer` renders it as text either way.
    expect(violation(marked({ type: 'link', attrs: { href: null } }))).toBeNull();
    expect(violation(marked({ type: 'link' }))).toBeNull();
    expect(violation(marked({ type: 'link', attrs: {} }))).toBeNull();
    // Still refused when the href is a value rather than an absence.
    expect(violation(marked({ type: 'link', attrs: { href: 42 } }))?.reason).toBe('bad_protocol');
  });

  it('accepts the schemes TipTap admits, because the editor writes them', () => {
    // `protocols: ['http','https','mailto']` only APPENDS to a hardcoded
    // baseline in `@tiptap/extension-link` — http, https, ftp, ftps, mailto,
    // tel, callto, sms, cid, xmpp — so a validator narrower than this list does
    // not make the app safer, it makes the post unsavable.
    for (const href of [
      'https://example.com',
      'http://example.com',
      'mailto:a@b.co',
      'tel:+15551234567',
      'sms:+15551234567',
      'ftp://files.example.com/x',
      'ftps://files.example.com/x',
      'callto:someone',
      'cid:part1.abc',
      'xmpp:someone@example.com',
    ]) {
      expect(violation(marked({ type: 'link', attrs: { href } })), href).toBeNull();
    }
    expect([...ALLOWED_LINK_PROTOCOLS].sort()).toEqual(
      [
        'callto:', 'cid:', 'ftp:', 'ftps:', 'http:', 'https:', 'mailto:', 'sms:', 'tel:', 'xmpp:',
      ].sort(),
    );
  });

  it('still refuses every scheme that is not on the list', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
      'blob:https://example.com/abc',
      'chrome://settings',
    ]) {
      expect(violation(marked({ type: 'link', attrs: { href } }))?.reason, href).toBe(
        'bad_protocol',
      );
    }
  });

  it('rejects a data: image src', () => {
    expect(violation(image('data:image/png;base64,AAAA'))).toEqual({
      path: 'content[0]',
      reason: 'bad_protocol',
    });
  });

  it('accepts asset:, idb:, https: and http: image srcs', () => {
    for (const src of [
      'asset:img_1',
      'idb:img_1',
      'https://cdn.example.com/a.png',
      'http://cdn.example.com/a.png',
    ]) {
      expect(violation(image(src))).toBeNull();
    }
  });

  it('refuses a path-shaped image id, which would be a path-shaped object key', () => {
    // Spec §3.6: `storage_key = images/<owner>/<id>`. `isStorableImageSrc` used
    // to accept ANY non-empty suffix, so `asset:../../etc/passwd` validated and
    // the id escaped its own prefix the moment anything joined it into a key.
    for (const src of [
      'asset:../../etc/passwd',
      'idb:../secret',
      'asset:img_a/../b',
      'asset:/absolute',
      'idb:img_a b',
      'asset:notanimage',
      'idb:',
      'asset:',
      `asset:img_${'x'.repeat(100)}`,
    ]) {
      expect(violation(image(src)), src).toEqual({ path: 'content[0]', reason: 'bad_protocol' });
    }
    expect(violation(image('asset:img_meyc0k9x8f2a1b3c4d5e6f7a8'))).toBeNull();
  });

  it('accepts http:, because the editor emits it and a 422 here is permanent', () => {
    /*
     * THIS CASE USED TO ASSERT THE OPPOSITE, and the inversion is the fix for
     * plan §9. Spec §4.6 lists {https, asset:, idb:}; the editor's paste repair
     * keeps an `http://` image (measured — `stripHostile` gates on
     * `isAllowedImageSrc`, which is http/https). `savePost` validates
     * `patch.content` on EVERY save and spec §8 makes a 422 a permanent stop in
     * the client's retry policy, so with the narrower list one pasted picture
     * made the post unsavable forever and the pending write was dropped rather
     * than retried.
     *
     * Widening the validator is the fix rather than narrowing the editor
     * because narrowing loses the picture on paste AND strands every document
     * that already holds one. `src/editor/schema-drift.test.tsx` is the durable
     * check — it drives a real `Editor` and a real `repairPastedHTML` — and it
     * fails against the narrower list, verified.
     */
    expect(violation(image('http://cdn.example.com/a.png'))).toBeNull();
    expect(violation(image('HTTP://CDN.EXAMPLE.COM/a.png'))).toBeNull();
  });

  it('still refuses every scheme the editor cannot produce', () => {
    // The list stayed an ALLOW-list, which is the property that makes widening
    // it by one member safe. A scheme-less src stays refused too: nothing in
    // the app writes one and the paste repair deletes one, so accepting it
    // would widen past what the editor emits for no document's benefit.
    for (const src of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/abc',
      '/relative.png',
      '//cdn.example.com/a.png',
      'photo.png',
    ]) {
      expect(violation(image(src)), src).toEqual({
        path: 'content[0]',
        reason: 'bad_protocol',
      });
    }
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

  it('bounds heading.level rather than storing whatever arrives', () => {
    // `level` is the one attribute a renderer turns into a TAG NAME, so an
    // unbounded one is an `<h999>` in spec §6's public renderer. Six and not the
    // editor's configured [2,3]: an imported document legitimately carries 1,
    // and refusing that loses the import rather than the attack.
    for (const level of [999, 0, -1, 2.5, '2', null, {}]) {
      const value = wrap({ type: 'heading', attrs: { level }, content: [] });
      // `null` means "absent", which ProseMirror fills from the schema default.
      if (level === null) expect(violation(value)).toBeNull();
      else expect(violation(value), String(level)).toEqual({
        path: 'content[0]',
        reason: 'bad_attrs',
      });
    }
    for (const level of [1, 2, 3, 6]) {
      expect(violation(wrap({ type: 'heading', attrs: { level }, content: [] }))).toBeNull();
    }
  });

  it('refuses an attribute no node or mark in the schema defines', () => {
    // Inert against today's `DocRenderer`, which enumerates the attributes it
    // reads — but spec §6's public renderer inherits whatever is stored, and
    // "the renderer happens to ignore it" is not a property the database can
    // rely on.
    expect(
      violation(marked({ type: 'link', attrs: { href: 'https://a.co', onclick: 'alert(1)' } })),
    ).toEqual({ path: 'content[0].content[0].marks[0]', reason: 'bad_attrs' });

    expect(violation(wrap({ type: 'paragraph', attrs: { onload: 'x' }, content: [] }))).toEqual({
      path: 'content[0]',
      reason: 'bad_attrs',
    });

    expect(
      violation(wrap({ type: 'image', attrs: { src: 'idb:img_1', srcset: 'evil' } })),
    ).toEqual({ path: 'content[0]', reason: 'bad_attrs' });
  });

  it('bounds a code block language, which reaches a class attribute', () => {
    expect(
      violation(
        wrap({
          type: 'codeBlock',
          attrs: { language: '"><script>alert(1)</script>' },
          content: [],
        }),
      ),
    ).toEqual({ path: 'content[0]', reason: 'bad_attrs' });
    for (const language of ['typescript', 'c++', 'objective-c', 'plaintext', null]) {
      expect(violation(wrap({ type: 'codeBlock', attrs: { language }, content: [] }))).toBeNull();
    }
  });

  it('keeps the attributes the editor actually writes', () => {
    // The other half of the same coin: an attribute set narrower than the schema
    // is the link-protocol defect again, one node type over. The live-schema
    // version of this lives in `src/editor/schema-drift.test.tsx`.
    const shapes: unknown[] = [
      { type: 'heading', attrs: { level: 2 }, content: [] },
      { type: 'orderedList', attrs: { start: 1, type: null }, content: [] },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [] }],
      },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [] },
      {
        type: 'image',
        attrs: { src: 'idb:img_1', alt: '', title: '', width: null, height: null },
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                content: [],
              },
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                content: [],
              },
            ],
          },
        ],
      },
    ];
    for (const shape of shapes) expect(violation(wrap(shape)), JSON.stringify(shape)).toBeNull();

    expect(
      violation(
        marked({
          type: 'link',
          attrs: {
            href: 'https://example.com',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            class: 'doc-link',
            title: null,
          },
        }),
      ),
    ).toBeNull();
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

// --------------------------------------------------------------- checkPostMeta

describe('checkPostMeta', () => {
  /*
   * The five other inputs to the same generated `search` tsvector.
   *
   * `MAX_CONTENT_TEXT_BYTES` bounded `content_text` and nothing else, so a
   * 1.2 MB title raised the same SQLSTATE 54000 on the same statement — a
   * `DbError` with no row in spec §8, i.e. a 500, which the client's retry
   * policy treats as transient and retries forever for a request that can never
   * succeed.
   */
  it('accepts everything the UI can produce', () => {
    // TITLE_MAX 160 / SUBTITLE_MAX 220 (src/routes/Editor.tsx), category 40 and
    // excerpt 320 (src/editor/MetaPanel.tsx), tags 32 characters each — every
    // one of them at 4 bytes per character.
    expect(
      checkPostMeta({
        title: '漢'.repeat(160),
        subtitle: '漢'.repeat(220),
        excerpt: '漢'.repeat(320),
        category: '漢'.repeat(40),
        tags: Array.from({ length: 32 }, () => '漢'.repeat(32)),
      }),
    ).toBeNull();
  });

  it('refuses each oversized field by name, so the 422 says which one', () => {
    expect(checkPostMeta({ title: 'x'.repeat(MAX_TITLE_BYTES + 1) })).toEqual({
      path: 'title',
      reason: 'too_large',
    });
    expect(checkPostMeta({ subtitle: 'x'.repeat(MAX_SUBTITLE_BYTES + 1) })).toEqual({
      path: 'subtitle',
      reason: 'too_large',
    });
    expect(checkPostMeta({ excerpt: 'x'.repeat(MAX_EXCERPT_BYTES + 1) })).toEqual({
      path: 'excerpt',
      reason: 'too_large',
    });
    expect(checkPostMeta({ category: 'x'.repeat(MAX_CATEGORY_BYTES + 1) })).toEqual({
      path: 'category',
      reason: 'too_large',
    });
    expect(checkPostMeta({ tags: [`${'x'.repeat(MAX_TAG_BYTES + 1)}`] })).toEqual({
      path: 'tags[0]',
      reason: 'too_large',
    });
    expect(checkPostMeta({ tags: Array.from({ length: MAX_TAGS + 1 }, () => 't') })).toEqual({
      path: 'tags',
      reason: 'too_large',
    });
  });

  it('counts bytes, not characters', () => {
    const cjk = '漢'.repeat(MAX_TITLE_BYTES / 3 + 1);
    expect(cjk.length).toBeLessThan(MAX_TITLE_BYTES);
    expect(checkPostMeta({ title: cjk })).toEqual({ path: 'title', reason: 'too_large' });
  });

  it('checks only the fields present, exactly as savePost validates only the patch', () => {
    // A stored value already over the line — an import, a backfill — must not
    // make the post permanently unsavable. That is the whole reason spec §4.6
    // validates `patch.content` and never the merge.
    expect(checkPostMeta({})).toBeNull();
    expect(checkPostMeta({ title: undefined, tags: undefined })).toBeNull();
  });

  it('reports a wrong type as malformed rather than coercing it', () => {
    expect(checkPostMeta({ title: 42 })).toEqual({ path: 'title', reason: 'malformed' });
    expect(checkPostMeta({ tags: 'a,b' })).toEqual({ path: 'tags', reason: 'malformed' });
    expect(checkPostMeta({ tags: [1] })).toEqual({ path: 'tags[0]', reason: 'malformed' });
  });

  it('the metadata budget fits inside the headroom the content ceiling leaves', () => {
    // The tsvector limit is MAXSTRPOS = 1 048 575 bytes and `content_text` at
    // its ceiling was measured at 808 580 in the worst adversarial shape. The
    // five metadata fields share what is left, so their worst-case sum has to
    // be a small fraction of it.
    const worst =
      MAX_TITLE_BYTES + MAX_SUBTITLE_BYTES + MAX_EXCERPT_BYTES + MAX_CATEGORY_BYTES +
      MAX_TAGS * MAX_TAG_BYTES;
    expect(worst).toBeLessThan(1_048_575 - 808_580);
  });
});
