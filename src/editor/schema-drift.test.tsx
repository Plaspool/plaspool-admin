/**
 * THE DRIFT GUARD. `shared/validate.ts` must accept everything this editor can
 * write, and this is the test that proves it against the LIVE ProseMirror
 * schema rather than against a hand-written fixture.
 *
 * The defect it exists for: `ALLOWED_LINK_PROTOCOLS` required a scheme match,
 * so `#fn1`, `/about`, `//cdn.example/x` and `?ref=1` — four shapes the editor
 * writes without complaint — were all refused as `bad_protocol`. Because
 * `savePost` validates `patch.content` on EVERY save, one such link made every
 * subsequent save 422, and spec §8 makes 422 a permanent stop in the client's
 * retry policy, so the pending write was dropped rather than retried. The
 * writer keeps typing into a post that can never be persisted. That is the
 * data-loss class this application exists to prevent, and a hand-written
 * fixture in `shared/validate.test.ts` could never have caught it, because the
 * fixture and the validator were written from the same wrong assumption.
 *
 * So this file is deliberately the other direction: it asks the editor what it
 * produces and holds the validator to that answer. Everything it asserts is
 * derived from `editorExtensions` at run time — add a TipTap extension, or take
 * a version bump that adds an attribute, and this fails here instead of in a
 * writer's browser.
 *
 * Lives under `src/` and not `shared/` on purpose: driving a real `Editor`
 * needs a DOM (the `ui` project is the jsdom one), and `shared/` must not
 * import from `src/`.
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions, repairPastedHTML } from './extensions';
import { ALLOWED_MARKS, ALLOWED_NODES, validateDoc } from '../../shared/validate';
import type { DocNode } from '../../shared/types';

/**
 * Every block, mark and attribute shape the schema has an arm for, in one
 * document. Written as HTML rather than as JSON so it goes through the real
 * parser and comes back with the real attribute defaults — `colwidth`, `align`,
 * `target`, `rel`, `class` and the rest are things TipTap adds, not things a
 * fixture author would think to write.
 */
const KITCHEN_SINK = `
<h2>Heading two</h2>
<h3>Heading three</h3>
<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s>
<code>code</code> <a href="https://example.com">link</a><br>after a hard break</p>
<blockquote><p>quoted</p></blockquote>
<ul><li><p>bullet</p></li></ul>
<ol><li><p>ordered</p></li></ol>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="true"><p>done</p></li>
  <li data-type="taskItem" data-checked="false"><p>todo</p></li>
</ul>
<pre><code class="language-typescript">const a = 1;</code></pre>
<hr>
<img src="idb:img_abc123" alt="a picture" title="a caption">
<table><tbody><tr><th><p>Head</p></th><td><p>Cell</p></td></tr></tbody></table>
`;

/**
 * Href shapes with no scheme at all. Every one of these is retained by the
 * editor and every one of these used to be refused by the validator.
 */
const RELATIVE_HREFS = ['#fn1', '/about', '//cdn.example/x', '?ref=1', 'archive/2026'];

/** Shapes the editor may or may not keep, depending on how Link is configured. */
const SCHEME_HREFS = [
  'https://example.com/a?b=1#c',
  'http://example.com',
  'mailto:someone@example.com',
  'tel:+15551234567',
  'ftp://files.example.com/x',
];

/** Must never survive, on either side. */
const HOSTILE_HREFS = [
  'javascript:alert(1)',
  ' javascript:alert(1)',
  'java\nscript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
];

/**
 * IMAGE `src`, AND WHY THE PIPELINE IS DIFFERENT FROM THE HREF ONE ABOVE.
 *
 * A link's gate is `Link.isAllowedUri`, which runs inside the ProseMirror
 * parse, so `new Editor({content})` is enough to ask the schema what it keeps.
 * An image has NO parse-time gate — measured on this repo's TipTap 3.29,
 * `new Editor({content: '<img src="javascript:alert(1)">'})` keeps the node
 * verbatim, and only `allowBase64: false` removes anything (`data:`). The gate
 * for images is `stripHostile` inside `repairPastedHTML`, which is where every
 * foreign `<img>` a writer can produce actually arrives.
 *
 * So this half of the drift guard drives BOTH: the repair (what the editor's
 * one real image entry point keeps) and then the schema parse of what came out
 * (what therefore lands in a document), and holds `validateDoc` to that answer.
 * Asking only the parser would assert nothing, because the parser keeps
 * everything.
 *
 * The `http:` row is the defect this table was added for (plan §9): the repair
 * keeps an `http://` image, and the validator refused it, so ONE pasted picture
 * made the post permanently unsavable.
 */
const IMAGE_SRCS = [
  // What the app writes itself: `Editor.tsx:262` (frozen) and, after migration,
  // the `asset:` rewrite. Both must survive a copy-paste between posts — F11.
  'idb:img_abc123',
  'asset:img_abc123',
  'https://cdn.example.com/chart.png',
  'http://cdn.example.com/chart.png',
];

/**
 * Refused by the repair AND by the validator. `data:` is doubly refused — the
 * repair removes it and `allowBase64: false` would not have parsed it anyway.
 */
const HOSTILE_IMAGE_SRCS = [
  'javascript:alert(1)',
  ' javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:image/png;base64,iVBORw0KGgo=',
  'vbscript:msgbox(1)',
];

/**
 * Shapes the validator refuses and the repair also refuses, so no document can
 * hold one. Listed rather than assumed: if a future repair rule starts keeping
 * them, this file goes red and names the validator that would then 422 them.
 */
const UNREACHABLE_IMAGE_SRCS = ['/relative.png', 'photo.png', '//cdn.example/x.png', '?ref=1'];

function editor(content?: string): Editor {
  return new Editor({ extensions: editorExtensions, content });
}

/** Every `type` in a document, node and mark alike. */
function typesIn(doc: DocNode): { nodes: Set<string>; marks: Set<string> } {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  const walk = (n: DocNode) => {
    nodes.add(n.type);
    for (const m of (n as { marks?: { type: string }[] }).marks ?? []) marks.add(m.type);
    n.content?.forEach(walk);
  };
  walk(doc);
  return { nodes, marks };
}

/** The link mark's `href` on the first text node carrying one. */
function hrefIn(doc: DocNode): string | null {
  let found: string | null = null;
  const walk = (n: DocNode) => {
    if (found !== null) return;
    for (const m of (n as { marks?: { type: string; attrs?: { href?: string } }[] }).marks ?? []) {
      if (m.type === 'link' && typeof m.attrs?.href === 'string') {
        found = m.attrs.href;
        return;
      }
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return found;
}

/** Every image node's `src`, in document order. Mirrors `hrefIn` above. */
function srcIn(doc: DocNode): string[] {
  const found: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'image' && typeof n.attrs?.src === 'string') found.push(n.attrs.src as string);
    n.content?.forEach(walk);
  };
  walk(doc);
  return found;
}

/** `<p>` beside the image so a case that drops the image still has a document. */
const withImage = (src: string) =>
  `<p>prose</p><img src="${src.replace(/"/g, '&quot;')}" alt="a picture">`;

describe('the validator accepts everything the editor writes', () => {
  it('every node and mark type in the live schema is on the allow-list', () => {
    /*
     * The allow-list is a hand-maintained transcription of the schema, so this
     * is the assertion that keeps it one. A node type the editor gained and the
     * validator did not is an `unknown_node` 422 on every save of every post
     * containing it.
     */
    const ed = editor();
    try {
      for (const name of Object.keys(ed.schema.nodes)) {
        expect(ALLOWED_NODES.has(name), `node type \`${name}\` is missing from ALLOWED_NODES`).toBe(
          true,
        );
      }
      for (const name of Object.keys(ed.schema.marks)) {
        expect(ALLOWED_MARKS.has(name), `mark type \`${name}\` is missing from ALLOWED_MARKS`).toBe(
          true,
        );
      }
    } finally {
      ed.destroy();
    }
  });

  it('a document holding every node, mark and attribute the editor emits validates', () => {
    const ed = editor(KITCHEN_SINK);
    try {
      const doc = ed.getJSON() as DocNode;
      const present = typesIn(doc);

      // The fixture is only worth anything if it actually exercises the schema,
      // so prove the coverage rather than assuming it. `doc` is the root and
      // `text` only appears where there is text, both of which the walk covers.
      for (const name of Object.keys(ed.schema.nodes)) {
        expect(present.nodes.has(name), `KITCHEN_SINK produces no \`${name}\` node`).toBe(true);
      }
      for (const name of Object.keys(ed.schema.marks)) {
        expect(present.marks.has(name), `KITCHEN_SINK produces no \`${name}\` mark`).toBe(true);
      }

      const result = validateDoc(doc);
      expect(
        result.ok ? null : result.violation,
        'the validator refused a document this editor just produced',
      ).toBeNull();
    } finally {
      ed.destroy();
    }
  });

  it.each(RELATIVE_HREFS)('keeps the scheme-less href %s, and the validator takes it', (href) => {
    const ed = editor(`<p><a href="${href}">anchor</a></p>`);
    try {
      const doc = ed.getJSON() as DocNode;
      // First half of the defect: the editor really does write these.
      expect(hrefIn(doc), `the editor dropped ${href}`).toBe(href);
      // Second half: the validator really did refuse them.
      const result = validateDoc(doc);
      expect(result.ok ? null : result.violation).toBeNull();
    } finally {
      ed.destroy();
    }
  });

  it.each(SCHEME_HREFS)('validates %s if the editor keeps it', (href) => {
    const ed = editor(`<p><a href="${href}">anchor</a></p>`);
    try {
      const doc = ed.getJSON() as DocNode;
      const kept = hrefIn(doc);
      // Not asserted to be kept: `Link.isAllowedUri` is the editor's to
      // configure and it may narrow. What is asserted is the one-way
      // implication that matters — whatever it keeps must be storable.
      if (kept === null) return;
      const result = validateDoc(doc);
      expect(result.ok ? null : result.violation, `${href} survived the editor`).toBeNull();
    } finally {
      ed.destroy();
    }
  });

  it.each(HOSTILE_HREFS)('refuses %j on both sides', (href) => {
    const ed = editor(`<p><a href="${href.replace(/"/g, '&quot;')}">anchor</a></p>`);
    try {
      // The editor strips the anchor; the validator refuses it even when handed
      // one directly, because a document can arrive from an import rather than
      // from this editor.
      expect(hrefIn(ed.getJSON() as DocNode)).toBeNull();
    } finally {
      ed.destroy();
    }

    const forged: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
        } as DocNode,
      ],
    };
    const result = validateDoc(forged);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.violation.reason).toBe('bad_protocol');
  });

  it.each(IMAGE_SRCS)('keeps the image src %s through paste, and the validator takes it', (src) => {
    // First half: the editor's real image entry point keeps it. `asset:` is the
    // row F11 is about — `stripHostile` used to delete it, so after migration
    // copying a section between posts silently removed every picture.
    const repaired = repairPastedHTML(withImage(src));
    expect(repaired, `repairPastedHTML dropped the image ${src}`).toContain('<img');
    expect(repaired).toContain(`src="${src}"`);

    // Second half: what the schema then makes of it must be storable. This is
    // the assertion that fails against the un-widened `isStorableImageSrc`,
    // for the `http:` row.
    const ed = editor(repaired);
    try {
      const doc = ed.getJSON() as DocNode;
      expect(srcIn(doc), `the schema dropped ${src}`).toEqual([src]);
      const result = validateDoc(doc);
      expect(
        result.ok ? null : result.violation,
        `${src} survived the editor and the validator refused it — every save of a post holding one is a permanent 422`,
      ).toBeNull();
    } finally {
      ed.destroy();
    }
  });

  it.each(HOSTILE_IMAGE_SRCS)('refuses the image src %j on both sides', (src) => {
    // The repair removes the element outright rather than leaving a src the
    // schema happens to ignore, so the count of images stays honest.
    const repaired = repairPastedHTML(withImage(src));
    expect(repaired).not.toContain('<img');
    expect(repaired).toContain('prose');

    // And a forged document — one that arrived from an import rather than from
    // this editor — is refused by the validator directly.
    const forged: DocNode = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src, alt: '' } } as DocNode],
    };
    const result = validateDoc(forged);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.violation.reason).toBe('bad_protocol');
  });

  it.each(UNREACHABLE_IMAGE_SRCS)('cannot produce the scheme-less image src %s', (src) => {
    /*
     * The ProseMirror parse keeps these — measured — so the claim that the
     * validator may refuse them rests entirely on the repair removing them
     * first. That is the thing worth pinning: widen the repair and this test
     * names the validator that would start 422-ing the result.
     */
    expect(repairPastedHTML(withImage(src))).not.toContain('<img');

    const forged: DocNode = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src, alt: '' } } as DocNode],
    };
    const result = validateDoc(forged);
    expect(result.ok).toBe(false);
  });
});
