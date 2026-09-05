/**
 * The round-trip contract for `doc-html.ts`.
 *
 * The bug these tests exist for: the CSV export carried `docToText` output and
 * the import wrapped it in one paragraph, so export → import flattened every
 * heading, list and bold run in the catalogue. It did that to two live products
 * on 2026-09-04. The assertion that would have caught it is `round trips a real
 * product description` below — a fixture taken from the document the accident
 * destroyed, not an invented one.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_MARKS, ALLOWED_NODES } from './validate';
import { docToHtml, htmlToDoc, normaliseDoc } from './doc-html';
import type { DocNode } from './types';

/** `doc` wrapping n blocks — every fixture below is written as its blocks. */
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });
const text = (value: string, marks?: DocNode['marks']): DocNode =>
  marks ? { type: 'text', marks, text: value } : { type: 'text', text: value };
const para = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });

/** The equality this module promises: exact, up to null attrs and empty content. */
function expectRoundTrip(input: DocNode): void {
  expect(htmlToDoc(docToHtml(input))).toEqual(normaliseDoc(input));
}

describe('docToHtml / htmlToDoc', () => {
  // ------------------------------------------------------------ the regression

  it('round trips a real product description — headings, bullets and bold survive', () => {
    // PLA Silk's stored description, the shape the CSV import flattened.
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Key Features')] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(text('Glossy, silk-like finish'))] },
          { type: 'listItem', content: [para(text('Low warping and easy-to-tune print settings'))] },
        ],
      },
      { type: 'heading', attrs: { level: 2 }, content: [text('Technical Specifications')] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [para(text('Material:', [{ type: 'bold' }]), text(' Silk PLA'))],
          },
        ],
      },
    );

    const html = docToHtml(input);
    expect(html).toContain('<h2>Key Features</h2>');
    expect(html).toContain('<strong>Material:</strong>');
    expect(html).toContain('<ul><li><p>Glossy, silk-like finish</p></li>');
    expectRoundTrip(input);
  });

  it('is idempotent — exporting what was imported produces identical HTML', () => {
    const html = '<h2>Key Features</h2><ul><li><p>One</p></li><li><p>Two</p></li></ul>';
    expect(docToHtml(htmlToDoc(html))).toBe(html);
  });

  // ------------------------------------------------------------ every node type

  it('has an arm for every node type the validator allows', () => {
    // A type the editor gains but this codec does not know would be silently
    // stripped from every export. Fail here instead, before a writer meets it.
    const covered = new Set<string>();
    for (const type of ALLOWED_NODES) {
      if (type === 'doc' || type === 'text') {
        covered.add(type);
        continue;
      }
      const probe: DocNode =
        type === 'hardBreak' || type === 'horizontalRule' || type === 'image'
          ? { type }
          : { type, content: [text('probe')] };
      const html = docToHtml(doc(probe));
      // The default arm emits the bare escaped text and no tag at all.
      if (html !== 'probe' && html !== '') covered.add(type);
    }
    expect([...ALLOWED_NODES].filter((t) => !covered.has(t))).toEqual([]);
  });

  it('round trips each block node with its attributes', () => {
    expectRoundTrip(doc(para(text('plain'))));
    expectRoundTrip(doc({ type: 'heading', attrs: { level: 3 }, content: [text('h3')] }));
    expectRoundTrip(doc({ type: 'blockquote', content: [para(text('quoted'))] }));
    expectRoundTrip(doc({ type: 'horizontalRule' }));
    expectRoundTrip(doc(para(text('a'), { type: 'hardBreak' }, text('b'))));
    expectRoundTrip(
      doc({
        type: 'orderedList',
        attrs: { start: 3, type: 'a' },
        content: [{ type: 'listItem', content: [para(text('third'))] }],
      }),
    );
    expectRoundTrip(
      doc({ type: 'image', attrs: { src: 'asset:img_1', alt: 'a spool', width: 800, height: 600 } }),
    );
  });

  it('round trips a code block with its language and its newlines', () => {
    const input = doc({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [text('const a = 1;\nconst b = 2;\n')],
    });
    expect(docToHtml(input)).toBe('<pre><code class="language-ts">const a = 1;\nconst b = 2;\n</code></pre>');
    expectRoundTrip(input);
  });

  it('round trips a task list, including its checked state', () => {
    const input = doc({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [para(text('todo'))] },
      ],
    });
    // Without data-type this is indistinguishable from a bullet list.
    expect(docToHtml(input)).toContain('data-type="taskList"');
    expectRoundTrip(input);
  });

  it('round trips a table, spans and colwidth included', () => {
    const input = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { colspan: 2, colwidth: [120, 240] }, content: [para(text('Spec'))] },
            { type: 'tableCell', attrs: { rowspan: 1 }, content: [para(text('Value'))] },
          ],
        },
      ],
    });
    expectRoundTrip(input);
  });

  it('lifts thead/tbody rows onto the table — neither is a schema node', () => {
    const parsed = htmlToDoc('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>');
    const table = parsed.content![0]!;
    expect(table.type).toBe('table');
    expect(table.content!.map((r) => r.type)).toEqual(['tableRow', 'tableRow']);
  });

  // ----------------------------------------------------------------- the marks

  it('has an arm for every mark the validator allows', () => {
    const missing = [...ALLOWED_MARKS].filter(
      (type) => docToHtml(doc(para(text('x', [{ type }])))) === '<p>x</p>',
    );
    expect(missing).toEqual([]);
  });

  it('round trips each mark, and a link keeps its attributes', () => {
    for (const type of ALLOWED_MARKS) {
      if (type === 'link') continue;
      expectRoundTrip(doc(para(text('marked', [{ type }]))));
    }
    expectRoundTrip(
      doc(para(text('shop', [{ type: 'link', attrs: { href: 'https://plaspool.com', target: '_blank', rel: 'noopener' } }]))),
    );
  });

  it('drops a null link attribute rather than writing target="null"', () => {
    // TipTap stores {href, target: null, rel: null, class: null} for a plain link.
    const input = doc(
      para(text('x', [{ type: 'link', attrs: { href: 'https://a.test', target: null, rel: null, class: null } }])),
    );
    expect(docToHtml(input)).toBe('<p><a href="https://a.test">x</a></p>');
    expectRoundTrip(input);
  });

  it('keeps the marks on a hard break', () => {
    /*
     * FOUND BY RUNNING ALL 106 STORED PRODUCT REVISIONS THROUGH THE CODEC, not
     * by a fixture: production has a heading that begins with a BOLDED line
     * break. `hardBreak` is `marks: "_"` in ProseMirror, so it may carry them,
     * and an early `return '<br>'` silently dropped the mark. Nobody writes
     * this on purpose, which is exactly why no invented fixture had it.
     */
    const input = doc({
      type: 'heading',
      attrs: { level: 2 },
      content: [
        { type: 'hardBreak', marks: [{ type: 'bold' }] },
        text('Why this heading', [{ type: 'bold' }]),
      ],
    });
    expect(docToHtml(input)).toBe('<h2><strong><br></strong><strong>Why this heading</strong></h2>');
    expectRoundTrip(input);
  });

  it('normalises an empty document to one empty paragraph, never content: []', () => {
    // The invalid value that locked the editor on every new product.
    expect(normaliseDoc({ type: 'doc', content: [] })).toEqual(doc({ type: 'paragraph' }));
    expectRoundTrip({ type: 'doc', content: [] });
  });

  it('nests stacked marks innermost-last so the order is stable', () => {
    const input = doc(para(text('both', [{ type: 'bold' }, { type: 'italic' }])));
    expect(docToHtml(input)).toBe('<p><strong><em>both</em></strong></p>');
    expectRoundTrip(input);
  });

  // -------------------------------------------------------------- tolerant input

  it('treats a cell with no tags as one paragraph, so a plain-text file still imports', () => {
    expect(htmlToDoc('Just some words')).toEqual(doc(para(text('Just some words'))));
  });

  it('never produces an empty doc — that value locks the editor', () => {
    // `{type:'doc',content:[]}` is invalid under the schema; hydrating it fires
    // onContentError and the description becomes uneditable (CLAUDE.md §2).
    for (const input of ['', '   ', '<p></p>', '<div></div>']) {
      const out = htmlToDoc(input);
      expect(out.content!.length).toBeGreaterThan(0);
    }
  });

  it('closes an omitted end tag instead of nesting the next block inside it', () => {
    expect(htmlToDoc('<p>one<p>two')).toEqual(doc(para(text('one')), para(text('two'))));
    expect(htmlToDoc('<ul><li>a<li>b</ul>').content![0]!.content).toHaveLength(2);
  });

  it('keeps the words of an unknown tag and none of its markup', () => {
    // One text node, not four: unwrapping must not leave adjacent text nodes.
    expect(htmlToDoc('<p>a <span style="color:red">b</span> <marquee>c</marquee></p>')).toEqual(
      doc(para(text('a b c'))),
    );
  });

  it('unwraps a block-bearing wrapper rather than losing its blocks', () => {
    expect(htmlToDoc('<div><h2>T</h2><p>b</p></div>')).toEqual(
      doc({ type: 'heading', attrs: { level: 2 }, content: [text('T')] }, para(text('b'))),
    );
  });

  it('ignores comments, doctypes and a stray naked angle bracket', () => {
    expect(htmlToDoc('<!-- hi --><p>a &lt; b</p>')).toEqual(doc(para(text('a < b'))));
    expect(htmlToDoc('<p>5 < 6</p>')).toEqual(doc(para(text('5 < 6'))));
  });

  it('drops whitespace between blocks but keeps it inside them', () => {
    expect(htmlToDoc('<p>a</p>\n  <p>b</p>')).toEqual(doc(para(text('a')), para(text('b'))));
    expect(htmlToDoc('<p>a  b</p>')).toEqual(doc(para(text('a  b'))));
  });

  it('escapes and decodes the characters that would otherwise break the markup', () => {
    const input = doc(para(text('Ampersand & angle < and > and "quote"')));
    expect(docToHtml(input)).toBe('<p>Ampersand &amp; angle &lt; and &gt; and "quote"</p>');
    expectRoundTrip(input);
    expect(htmlToDoc('<p>&#8212;&#x2014;&nbsp;&unknown;</p>')).toEqual(
      // &nbsp; is U+00A0, and an unknown entity survives as its own text.
      doc(para(text('—— &unknown;'))),
    );
  });

  it('strips a script tag to its text rather than carrying it into the document', () => {
    // The cell is a spreadsheet's, not an editor's — nothing here may mint markup.
    const out = htmlToDoc('<p>safe</p><script>alert(1)</script>');
    expect(JSON.stringify(out)).not.toContain('script');
  });

  it('keeps only the attributes the validator allows on a link', () => {
    const out = htmlToDoc('<p><a href="https://a.test" onclick="x()" style="color:red">t</a></p>');
    expect(out.content![0]!.content![0]!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://a.test' } },
    ]);
  });

  it('reads a checklist back out of the node view markup the renderer emits', () => {
    // DocRenderer writes li > label(input + span) + div; the words are in the div.
    const out = htmlToDoc(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">' +
        '<label><input type="checkbox" checked><span></span></label><div><p>ship it</p></div></li></ul>',
    );
    expect(out).toEqual(
      doc({
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('ship it'))] }],
      }),
    );
  });

  it('returns empty HTML for an absent document', () => {
    expect(docToHtml(null)).toBe('');
    expect(docToHtml(undefined)).toBe('');
  });
});
