// @vitest-environment jsdom
/**
 * Paste: what survives, what is translated, and what must never get through.
 *
 * Everything a writer pastes is someone else's HTML. GAUNTLET.md Round 1 Part 2
 * finding #4 is what happens when nobody pins that down — pasting from any
 * external source silently destroyed every `<h1>`, and table rows arrived as one
 * undifferentiated run of cell text. This file is the regression net for that
 * finding and for the six repair rules that grew out of it.
 *
 * Two ideas run through the whole matrix:
 *
 * 1. **No words are lost.** `expectWordsSurvive` is called by every case that
 *    pastes anything. A repair that drops a sentence is worse than one that
 *    drops a font, so the default assertion is not "the output looks right" but
 *    "every visible word of the source is still in the document". Where a word
 *    legitimately moves (a `<figcaption>` becomes the image node's `title`) the
 *    case says so in `alsoIn`, and where one is genuinely lost (a caption past
 *    the 200-character cap) it is named in `except` — never skipped.
 *
 * 2. **The hostile section is a security suite**, not a formatting one. It
 *    asserts on the *serialised* document — no `on*` key, no `javascript:`,
 *    `vbscript:` or `data:` value anywhere — and then asserts the same thing
 *    again on `DocRenderer`'s output, because the reader's allow-list is a
 *    second gate that must hold even if the first one is ever bypassed.
 *
 * How the pipeline is driven: `editor.view.pasteHTML(html, event)` runs the real
 * paste path — `transformPastedHTML` (so `repairPastedHTML`) and then the schema
 * parse — which is what these assertions are about. jsdom 27 has no global
 * `ClipboardEvent`, so the event has to be supplied rather than left for
 * ProseMirror to construct; a bare `Event('paste')` carries no `clipboardData`,
 * which also means the image-paste plugin declines it and the standard path
 * runs. `pasteText` is the `text/plain` half of the same call.
 *
 * The small editor harness below deliberately does not come from `harness.tsx`:
 * that module reaches into Dexie for its round-trip helpers, and nothing here
 * touches storage, so importing it would drag `fake-indexeddb` into a suite that
 * has no database in it.
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { countRemoteImages, editorExtensions, repairPastedHTML } from '../extensions';
import { DocRenderer } from '../../components/DocRenderer';
import { docToText } from '../../data/doc';
import { ALLOWED_LINK_PROTOCOLS, isAllowedHref, isAllowedImageSrc } from '../../data/docguards';
import type { DocNode } from '../../data/types';
import {
  ARTICLE,
  CODE_HTML,
  CODE_PRE,
  CODE_TEXT,
  DEEP_QUOTES,
  GOOGLE_DOCS,
  HEADINGS,
  HOSTILE,
  IMAGES,
  LONG_CAPTION_FIGURE,
  LONG_CAPTION_TAIL,
  NESTED_LISTS,
  NOTION,
  PLAIN_MARKDOWN,
  SAFE_LINKS,
  TABLE,
  TERMINAL_TEXT,
  WORD,
} from './fixtures/clipboard';

// ------------------------------------------------------------------- harness

function mk(): Editor {
  return new Editor({ extensions: editorExtensions, element: document.createElement('div') });
}

/** jsdom has no `ClipboardEvent`; ProseMirror only forwards this to handlePaste. */
function pasteEvent(): ClipboardEvent {
  return new Event('paste') as unknown as ClipboardEvent;
}

function pasteHTML(editor: Editor, html: string): void {
  editor.view.pasteHTML(html, pasteEvent());
}

function pasteText(editor: Editor, text: string): void {
  const view = editor.view as unknown as { pasteText: (t: string, e: ClipboardEvent) => void };
  view.pasteText(text, pasteEvent());
}

/** Paste into a fresh editor and hand back the resulting document. */
function pastedHTML(html: string): DocNode {
  const editor = mk();
  try {
    pasteHTML(editor, html);
    return editor.getJSON() as unknown as DocNode;
  } finally {
    editor.destroy();
  }
}

function pastedText(text: string): DocNode {
  const editor = mk();
  try {
    pasteText(editor, text);
    return editor.getJSON() as unknown as DocNode;
  } finally {
    editor.destroy();
  }
}

function reader(doc: DocNode): string {
  return renderToStaticMarkup(<DocRenderer doc={doc} />);
}

// ------------------------------------------------- the content-preservation helper

/**
 * Visible text of a clipboard payload. `<script>`/`<style>` contents are code,
 * not words — nobody pastes a page expecting its stylesheet to become prose —
 * so they are removed before the text is read.
 *
 * Element boundaries become whitespace, exactly as `docToText` does it. Plain
 * `textContent` would read `<h1>Alpha</h1><h2>Bravo</h2>` as one token
 * `AlphaBravo`, which no document could ever contain — the comparison has to
 * tokenise both sides the same way or it only ever measures the difference
 * between two text extractors.
 */
function visibleText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  const out: string[] = [];
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) out.push(child.nodeValue ?? '');
      else if (child.nodeType === Node.ELEMENT_NODE) {
        // Both sides: `<li>Groceries<ol>…` has a boundary before the sublist as
        // well as after it, and a missing one fuses two real words into one
        // token that could never be found.
        out.push(' ');
        walk(child);
        out.push(' ');
      }
    }
  };
  walk(doc.body);
  return out.join('').replace(/\s+/g, ' ').trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Every text run in document order — whitespace intact, unlike `docToText`. */
function textRuns(node: DocNode, out: string[] = []): string[] {
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.content ?? []) textRuns(child, out);
  return out;
}

interface Preservation {
  /**
   * Extra places a word may legitimately have landed. A `<figcaption>` becomes
   * the image node's `title` attribute: still shown to the reader, but not text
   * inside the document tree, so `docToText` cannot see it.
   */
  alsoIn?: string[];
  /** Words the case knowingly gives up, each with the reason it is acceptable. */
  except?: { word: string; because: string }[];
}

/**
 * `words(source) ⊆ words(resultingDocText)` — the invariant the repair pipeline
 * exists to protect.
 *
 * Containment is checked by substring rather than by token equality on purpose:
 * repairs legitimately fuse tokens at block boundaries (unwrapping a footnote
 * anchor turns `disputed` + `1` into `disputed1`), and that is a formatting
 * change, not a lost word. A token that has genuinely vanished is still caught,
 * which is what this guards.
 */
function expectWordsSurvive(
  source: { html: string } | { text: string },
  doc: DocNode,
  { alsoIn = [], except = [] }: Preservation = {},
): void {
  const sourceText = 'html' in source ? visibleText(source.html) : source.text;
  const haystack = [docToText(doc), ...alsoIn].join(' ');
  const missing = words(sourceText).filter((w) => !haystack.includes(w));

  const allowed = new Set(except.map((e) => e.word));
  expect(missing.filter((w) => !allowed.has(w))).toEqual([]);
  // A stale exception is a test that has stopped testing: if the word now
  // survives, the exception has to go rather than sit there passing.
  for (const e of except) {
    expect(missing, `exception "${e.word}" (${e.because}) no longer applies`).toContain(e.word);
  }
}

// ------------------------------------------------------------- doc inspection

function nodesOfType(node: DocNode, type: string, out: DocNode[] = []): DocNode[] {
  if (node.type === type) out.push(node);
  for (const child of node.content ?? []) nodesOfType(child, type, out);
  return out;
}

function firstOfType(node: DocNode, type: string): DocNode | undefined {
  return nodesOfType(node, type)[0];
}

function typesIn(node: DocNode, out: Set<string> = new Set()): Set<string> {
  out.add(node.type);
  for (const child of node.content ?? []) typesIn(child, out);
  return out;
}

/** Deepest chain of nodes matching `match` along any single root-to-leaf path. */
function maxNesting(node: DocNode, match: (n: DocNode) => boolean, depth = 0): number {
  const here = match(node) ? depth + 1 : depth;
  return (node.content ?? []).reduce(
    (best, child) => Math.max(best, maxNesting(child, match, here)),
    here,
  );
}

const isList = (n: DocNode) => n.type === 'bulletList' || n.type === 'orderedList';

/** Every mark of `type` in the document, paired with the text it is applied to. */
function marked(doc: DocNode, type: string): string[] {
  return nodesOfType(doc, 'text')
    .filter((n) => (n.marks ?? []).some((m) => m.type === type))
    .map((n) => n.text ?? '');
}

/** The `href` of every link mark in the document — what survived the gate. */
function hrefsIn(doc: DocNode): string[] {
  return nodesOfType(doc, 'text')
    .flatMap((n) => n.marks ?? [])
    .filter((m) => m.type === 'link')
    .map((m) => String(m.attrs?.href ?? ''));
}

// =============================================================== 1. Google Docs

describe('paste from Google Docs', () => {
  it('drops the canvas noise but keeps bold and italic as marks', () => {
    const repaired = repairPastedHTML(GOOGLE_DOCS);
    // The wrapper, the font stack, the colours and the line height all describe
    // Docs' page, not the writing.
    expect(repaired).not.toContain('docs-internal-guid');
    expect(repaired).not.toContain('font-family');
    expect(repaired).not.toContain('color:');
    expect(repaired).not.toContain('line-height');
    expect(repaired).not.toContain('white-space');

    const doc = pastedHTML(GOOGLE_DOCS);
    expect(marked(doc, 'bold')).toEqual(['retention']);
    expect(marked(doc, 'italic')).toEqual(['acquisition']);
    expectWordsSurvive({ html: GOOGLE_DOCS }, doc);
  });

  it('does not let the outer <b style="font-weight:normal"> bold the document', () => {
    const doc = pastedHTML(GOOGLE_DOCS);
    const runs = nodesOfType(doc, 'text');
    const bolded = runs.filter((n) => (n.marks ?? []).some((m) => m.type === 'bold'));
    // One span asked for bold. The wrapper asked for nothing and must get it.
    expect(runs.length).toBeGreaterThan(1);
    expect(bolded).toHaveLength(1);
  });

  it('keeps the heading structure (h1 demoted to h2, never flattened away)', () => {
    const doc = pastedHTML(GOOGLE_DOCS);
    const headings = nodesOfType(doc, 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0].attrs?.level).toBe(2);
    expect(docToText(headings[0])).toBe('Quarterly Notes');
  });
});

// ================================================== 2. Microsoft Word / Outlook

describe('paste from Microsoft Word / Outlook', () => {
  it('strips the Office chrome', () => {
    const repaired = repairPastedHTML(WORD);
    expect(repaired).not.toContain('<o:p');
    expect(repaired).not.toContain('MsoNormal');
    expect(repaired).not.toContain('MsoListParagraph');
    expect(repaired).not.toContain('mso-');
    expect(repaired).not.toContain('class=');
    expect(repaired).not.toContain('<!--');
  });

  it('keeps the heading/paragraph structure and the bold run', () => {
    const doc = pastedHTML(WORD);
    const blocks = (doc.content ?? []).map((n) => n.type);
    expect(blocks).toEqual(['heading', 'paragraph', 'heading', 'paragraph']);
    expect(doc.content?.[0].attrs?.level).toBe(2); // h1 → h2
    expect(doc.content?.[2].attrs?.level).toBe(2); // h2 unchanged
    expect(marked(doc, 'bold')).toEqual(['Margins held']);
    expectWordsSurvive({ html: WORD }, doc);
  });

  it('leaves smart quotes, apostrophes and em dashes exactly as Word wrote them', () => {
    const text = docToText(pastedHTML(WORD));
    // Correct typography, not noise: normalising these would be vandalism.
    expect(text).toContain('“Quarterly”');
    expect(text).toContain('that’s');
    expect(text).toContain('—');
    expect(text).not.toContain('"Quarterly"');
    expect(text).not.toContain("that's");
  });
});

// ======================================================================= 3. Notion

describe('paste from Notion', () => {
  it('translates the checkbox list into a real taskList, keeping checked state', () => {
    const doc = pastedHTML(NOTION);
    const items = nodesOfType(doc, 'taskItem');
    expect(nodesOfType(doc, 'taskList')).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items.map((n) => n.attrs?.checked)).toEqual([true, false]);
    expect(items.map((n) => docToText(n))).toEqual([
      'Draft the announcement',
      'Schedule the window',
    ]);
    // The `<input>` is chrome once its state has been read.
    expect(repairPastedHTML(NOTION)).not.toContain('<input');
  });

  it('keeps three levels of mixed list nesting', () => {
    const doc = pastedHTML(NOTION);
    expect(maxNesting(doc, isList)).toBe(3);
    const outer = firstOfType(doc, 'bulletList')!;
    expect(firstOfType(outer, 'orderedList')).toBeDefined();
    expect(firstOfType(firstOfType(outer, 'orderedList')!, 'bulletList')).toBeDefined();
  });

  it('keeps the code block and its language', () => {
    const doc = pastedHTML(NOTION);
    const code = firstOfType(doc, 'codeBlock');
    expect(code).toBeDefined();
    expect(code!.attrs?.language).toBe('javascript');
    expect(docToText(code!)).toContain('await freeze()');
    expectWordsSurvive({ html: NOTION }, doc);
  });
});

// ========================================================= 4. VS Code / terminal

describe('paste from VS Code / a terminal', () => {
  it('preserves whitespace character-for-character inside an existing code block', () => {
    const editor = mk();
    editor.chain().focus().toggleCodeBlock().run();
    pasteText(editor, CODE_TEXT);
    const doc = editor.getJSON() as unknown as DocNode;
    editor.destroy();

    const code = firstOfType(doc, 'codeBlock')!;
    // Character for character: every tab and every newline is content.
    expect(textRuns(code).join('')).toBe(CODE_TEXT);
    expectWordsSurvive({ text: CODE_TEXT }, doc);
  });

  it('preserves whitespace when the source arrives as a styled <pre>', () => {
    const editor = mk();
    editor.chain().focus().toggleCodeBlock().run();
    pasteHTML(editor, CODE_PRE);
    const doc = editor.getJSON() as unknown as DocNode;
    editor.destroy();

    const code = firstOfType(doc, 'codeBlock')!;
    expect(textRuns(code).join('')).toBe(CODE_TEXT);
    expectWordsSurvive({ html: CODE_PRE }, doc);
  });

  it('turns a <pre> pasted at an empty paragraph into a code block, intact', () => {
    const doc = pastedHTML(CODE_PRE);
    const code = firstOfType(doc, 'codeBlock');
    expect(code).toBeDefined();
    expect(textRuns(code!).join('')).toBe(CODE_TEXT);
    expectWordsSurvive({ html: CODE_PRE }, doc);
  });

  it('keeps every line when plain text is pasted into a paragraph', () => {
    const doc = pastedText(TERMINAL_TEXT);
    // One block per line, in order — nothing merged, nothing dropped.
    expect(doc.content?.every((n) => n.type === 'paragraph')).toBe(true);
    expect(textRuns(doc).join('\n')).toBe(TERMINAL_TEXT);
    expectWordsSurvive({ text: TERMINAL_TEXT }, doc);
  });

  /*
   * Pasting a `<pre>` into the *middle* of a paragraph is the one case where the
   * result is a single inline run rather than a block: ProseMirror cannot open a
   * code block inside a textblock, so the slice arrives as inline text. Nothing
   * is lost — the tabs and newlines are still there in the document — but the
   * reader collapses them, because a `<p>` is not `white-space: pre`. That is a
   * fidelity gap, and it is pinned here rather than papered over.
   */
  it('keeps the content when a <pre> lands mid-paragraph, as one inline run', () => {
    const editor = mk();
    editor.chain().focus().insertContent('Log follows: ').run();
    pasteHTML(editor, CODE_PRE);
    const doc = editor.getJSON() as unknown as DocNode;
    editor.destroy();

    const joined = textRuns(doc).join('');
    expect(joined).toContain(CODE_TEXT);
    for (const line of CODE_TEXT.split('\n')) expect(joined).toContain(line);
    expectWordsSurvive({ html: CODE_PRE }, doc);
  });

  it('keeps every line of a VS Code <pre><div>-per-line payload', () => {
    const doc = pastedHTML(CODE_HTML);
    const joined = textRuns(doc).join('\n');
    for (const line of CODE_TEXT.split('\n')) expect(joined).toContain(line.trim());
    expectWordsSurvive({ html: CODE_HTML }, doc);
  });
});

// ================================================================== 5. Web article

describe('paste from a web article', () => {
  it('lifts the figcaption onto the image node title', () => {
    const doc = pastedHTML(ARTICLE);
    const img = firstOfType(doc, 'image');
    expect(img).toBeDefined();
    expect(img!.attrs?.src).toBe('https://cdn.example.com/photo.jpg');
    expect(img!.attrs?.title).toBe('Dawn over the harbour, taken in March');
    expect(img!.attrs?.alt).toBe('A harbour at dawn');
    // Nothing left behind as a stray paragraph.
    expect(docToText(doc)).not.toContain('Dawn over the harbour');
    // And the reader shows it, so the caption is not lost — only relocated.
    expect(reader(doc)).toContain('Dawn over the harbour, taken in March');
  });

  it('keeps the cite text inside the quote', () => {
    const doc = pastedHTML(ARTICLE);
    const quote = firstOfType(doc, 'blockquote');
    expect(quote).toBeDefined();
    expect(docToText(quote!)).toContain('Nothing about this was inevitable');
    expect(docToText(quote!)).toContain('Marta Alvarez');
  });

  it('keeps the #fn1 footnote link, because a fragment is a real href', () => {
    const doc = pastedHTML(ARTICLE);
    // This used to assert the opposite. A scheme-less href is relative, not
    // invalid — `#fn1`, `/about` and `?ref=1` are all things the editor writes,
    // and refusing them made any post containing one unsavable. So the footnote
    // anchor survives rather than being flattened to text.
    expect(isAllowedHref('#fn1')).toBe(true);
    expect(hrefsIn(doc)).toContain('#fn1');
    expect(docToText(doc)).toContain('disputed1 more than once');

    // The caption is the one word-group that legitimately leaves the text tree.
    expectWordsSurvive({ html: ARTICLE }, doc, {
      alsoIn: [String(firstOfType(doc, 'image')?.attrs?.title ?? '')],
    });
  });

  /*
   * This case used to record a real loss: `liftFigureCaptions` truncated the
   * title to 200 characters, matching the caption input's `maxLength`, so a
   * pasted caption longer than that silently lost its tail. That cap governs
   * what a writer may type; applying it to text they pasted is losing their
   * words on the way in. The truncation is gone and this test now guards its
   * absence — with no `except`, so the preservation helper covers the whole
   * caption rather than being told to look away.
   */
  it('keeps an over-long figcaption whole rather than capping it', () => {
    const doc = pastedHTML(LONG_CAPTION_FIGURE);
    const title = String(firstOfType(doc, 'image')?.attrs?.title ?? '');
    expect(title.length).toBeGreaterThan(200);
    expect(title).toContain(LONG_CAPTION_TAIL);

    expectWordsSurvive({ html: LONG_CAPTION_FIGURE }, doc, {
      alsoIn: [title],
    });
  });
});

// ==================================================== 6. Plain text with markdown

describe('paste of plain text that looks like markdown', () => {
  /*
   * The documented rule: input rules fire as you *type*, paste does not. A log
   * file, a config dump or a markdown source file has to arrive verbatim, or
   * pasting a README silently rewrites it.
   */
  it('stays literal — no heading, no list, no rule', () => {
    const doc = pastedText(PLAIN_MARKDOWN);
    const types = typesIn(doc);
    expect(types.has('heading')).toBe(false);
    expect(types.has('bulletList')).toBe(false);
    expect(types.has('orderedList')).toBe(false);
    expect(types.has('horizontalRule')).toBe(false);
    expect(doc.content?.every((n) => n.type === 'paragraph')).toBe(true);

    expect(textRuns(doc)).toEqual(['## Heading', '- item', '---']);
    expectWordsSurvive({ text: PLAIN_MARKDOWN }, doc);
  });

  it('keeps the markers visible to the reader too', () => {
    const html = reader(pastedText(PLAIN_MARKDOWN));
    expect(html).toContain('## Heading');
    expect(html).toContain('- item');
    expect(html).toContain('---');
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<hr');
  });
});

// ================================================================= 7. Hostile HTML

describe('hostile HTML (security)', () => {
  const serialised = () => JSON.stringify(pastedHTML(HOSTILE));

  /*
   * Gate one, on its own. The schema would refuse most of this anyway — there is
   * no `script` node and no `onclick` attribute for it to land in — so asserting
   * only on the parsed document would pass even if `stripHostile` were deleted.
   * This pins the sanitiser at the point where it actually runs.
   */
  it('is sanitised by repairPastedHTML before the schema ever sees it', () => {
    const repaired = repairPastedHTML(HOSTILE);
    expect(repaired).not.toContain('<script');
    expect(repaired).not.toContain('<style');
    expect(repaired).not.toContain('<iframe');
    expect(repaired).not.toContain('<svg');
    expect(repaired).not.toContain('<img'); // `src=x` and `data:` are both refused
    expect(repaired).not.toMatch(/\son[a-z]+\s*=/i);
    expect(repaired).not.toMatch(/javascript:/i);
    expect(repaired).not.toMatch(/vbscript:/i);
    expect(repaired).not.toMatch(/data:/i);
    // …and the words are already intact at this stage, not rescued later.
    expect(repaired).toContain('click');
    expect(repaired).toContain('text');
    expect(repaired).toContain('payload');
    expect(repaired).toContain('legacy');
    expect(repaired).toContain('entity');
    expect(repaired).toContain('tabbed');
  });

  it('rejects an entity-encoded and a control-character-split protocol', () => {
    // A control character inside the scheme is stripped before the check, so
    // `java\tscript:` is recognised as `javascript:` and refused.
    expect(isAllowedHref('java\tscript:alert(1)')).toBe(false);
    expect(isAllowedHref('java\nscript:alert(1)')).toBe(false);

    // The entity form is decoded by the HTML parser, not by `isAllowedHref` —
    // by the time the attribute exists it is already the literal
    // `javascript:alert(1)`. Asserting on the raw entity string would be
    // testing an input this code can never receive, so assert the path that
    // actually happens: parse the hostile markup and look at the document.
    const doc = pastedHTML(HOSTILE);
    for (const href of hrefsIn(doc)) {
      expect(href.toLowerCase()).not.toMatch(/^\s*(javascript|data|vbscript):/);
    }
    // Which is the point: the dangerous anchor goes, the word stays.
    expect(docToText(doc)).toContain('entity');
    expect(docToText(doc)).toContain('tabbed');
  });

  it('admits no script or iframe node', () => {
    const doc = pastedHTML(HOSTILE);
    const types = typesIn(doc);
    expect(types.has('script')).toBe(false);
    expect(types.has('iframe')).toBe(false);
    expect(nodesOfType(doc, 'image')).toEqual([]);
  });

  it('carries no on* attribute anywhere in the document', () => {
    // A JSON key beginning `on` is exactly an event-handler attribute.
    expect(serialised()).not.toMatch(/"on[a-z]+"\s*:/i);
    expect(serialised()).not.toMatch(/onerror|onload|onclick/i);
  });

  it('carries no javascript:, vbscript: or data: value anywhere', () => {
    expect(serialised()).not.toMatch(/javascript:/i);
    expect(serialised()).not.toMatch(/vbscript:/i);
    expect(serialised()).not.toMatch(/data:/i);
  });

  it('keeps the visible words — stripping the attack must not eat the sentence', () => {
    const doc = pastedHTML(HOSTILE);
    const text = docToText(doc);
    expect(text).toContain('click');
    expect(text).toContain('text');
    expect(text).toContain('payload');
    expect(text).toContain('legacy');
    // `alert(1)` lives inside <script> and `stolen` inside <style>. Neither is
    // visible text, so neither is a word: the helper's source extraction drops
    // both before comparing, and neither may reappear as prose.
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('stolen');
    expectWordsSurvive({ html: HOSTILE }, doc);
  });

  it('is refused a second time by the reader, independently', () => {
    const html = reader(pastedHTML(HOSTILE));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toMatch(/onerror|onload|onclick/i);
    expect(html).not.toMatch(/javascript:|vbscript:/i);
    expect(html).toContain('click');
    expect(html).toContain('text');
  });

  /*
   * The reader is not merely downstream of the repair — it re-decides. This
   * feeds DocRenderer a document the paste pipeline would never produce (a
   * `javascript:` link mark, a `data:text/html` image, an unknown `script`
   * node), which is what a future backend serving a foreign document could.
   */
  it('re-decides for itself on a document the editor never produced', () => {
    const planted: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: 'legacy',
              marks: [{ type: 'link', attrs: { href: 'vbscript:msgbox' } }],
            },
          ],
        },
        { type: 'image', attrs: { src: 'data:text/html;base64,PHNjcmlwdD4=', alt: 'x' } },
        { type: 'script', content: [{ type: 'text', text: 'alert(1)' }] },
      ],
    };
    const html = reader(planted);

    expect(html).not.toMatch(/javascript:|vbscript:/i);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('<script');
    // Words still reach the reader; only the dangerous shapes are refused.
    expect(html).toContain('click');
    expect(html).toContain('legacy');
    expect(html).toContain('Image unavailable');
  });

  it('keeps the links the allow-list does accept', () => {
    const doc = pastedHTML(SAFE_LINKS);
    const hrefs = nodesOfType(doc, 'text')
      .flatMap((n) => n.marks ?? [])
      .filter((m) => m.type === 'link')
      .map((m) => String(m.attrs?.href));
    // `tel:` is accepted now — the editor emits it, so a validator that refused
    // it made the post unsavable rather than making anything safer.
    expect(hrefs).toEqual([
      'https://example.com/docs',
      'mailto:team@example.com',
      'tel:+15550100',
    ]);
    expect(docToText(doc)).toContain('call us');
    expectWordsSurvive({ html: SAFE_LINKS }, doc);

    const html = reader(doc);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    // The reader gates on the same predicate, so it keeps it too — which is the
    // agreement between the two surfaces that this whole list exists to hold.
    expect(html).toContain('tel:+15550100');
  });
});

describe('the URL allow-list itself', () => {
  /*
   * These assertions were narrower and were WRONG, in a way worth recording.
   *
   * The original reasoning: TipTap's baseline allows `tel:`/`ftp:`/`xmpp:`, so
   * the editor accepted links the reader then stripped of their anchor — writer
   * sees a link, article shows bare text. True, and the fix I chose was to
   * narrow the editor down to the reader's three protocols.
   *
   * That fix creates a worse bug than the one it closes. `savePost` validates
   * `patch.content` on every save and a validation refusal is a *permanent* stop
   * in the retry policy, so a validator narrower than what the editor can emit
   * makes the post unsavable — the writer keeps typing into something that can
   * never be persisted. The same applies to scheme-less hrefs: `#footnote`,
   * `/about` and `?ref=1` are all things the editor writes.
   *
   * The right fix is one list, wide enough to hold everything the editor emits,
   * enforced identically on both surfaces — which is what `shared/validate.ts`
   * now does, with a drift guard that drives a real Editor. The security
   * property is unchanged and is what these cases exist for: it is an
   * allow-list, so `javascript:`, `data:` and `vbscript:` are absent by
   * construction, and no amount of obfuscation gets them in.
   */
  const CASES: [value: unknown, href: boolean, image: boolean][] = [
    ['http://a', true, true],
    ['https://a', true, true],
    ['mailto:a@b', true, false],
    // The attack surface. Still rejected, which is the point of the list.
    ['javascript:x', false, false],
    [' javascript:x', false, false], // leading space must not smuggle it past
    ['JavaScript:x', false, false], // nor a different case
    ['java\nscript:x', false, false], // nor an embedded control character
    ['data:text/html,x', false, false],
    ['vbscript:x', false, false],
    // Protocols the editor genuinely emits. Refusing these made posts unsavable.
    ['tel:123', true, false],
    ['ftp://a', true, false],
    ['xmpp:a', true, false],
    // Scheme-less is relative, and relative is allowed — `protocolOf` does the
    // de-obfuscation, so "names no scheme" cannot be faked.
    ['//evil.com', true, false],
    ['/relative', true, false],
    ['#footnote', true, false],
    ['', true, false],
    // Not a string at all is still a hard no.
    [null, false, false],
    [undefined, false, false],
  ];

  it.each(CASES)('isAllowedHref(%o) === %s / isAllowedImageSrc === %s', (value, href, image) => {
    expect(isAllowedHref(value)).toBe(href);
    expect(isAllowedImageSrc(value)).toBe(image);
  });

  it('never admits an executable scheme, however the list grows', () => {
    for (const scheme of ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']) {
      expect(ALLOWED_LINK_PROTOCOLS).not.toContain(scheme);
    }
  });

  it('is the same list the editor and the reader both gate on', () => {
    // Not pinned to a literal array any more: the list is owned by
    // `shared/validate.ts` so the server applies it too, and pinning its exact
    // contents here would just break every time a legitimate scheme is added.
    // What must hold is that it starts with the web schemes and stays an
    // allow-list of `scheme:` strings.
    expect(ALLOWED_LINK_PROTOCOLS).toEqual(
      expect.arrayContaining(['http:', 'https:', 'mailto:']),
    );
    expect(ALLOWED_LINK_PROTOCOLS.every((p) => /^[a-z][a-z0-9+.-]*:$/.test(p))).toBe(true);
  });
});

// ================================================================= 8. Pasted images

describe('pasted images', () => {
  /*
   * NOT tested here, deliberately: the async `data:` → `storeImageFile` → `idb:`
   * conversion in `handlePaste`. It needs a real `ClipboardEvent` with
   * `clipboardData` (absent in jsdom 27), and `storeImageFile` decodes through
   * `createImageBitmap`, which jsdom does not implement. What that path does on
   * success is covered by the image-store tests; what it does when it never runs
   * — a `data:` image reaching `repairPastedHTML` — is covered below.
   */
  it('counts only the images that live on another site', () => {
    // https counts, `idb:` is already local, `data:` never survives, no-src is nothing.
    expect(countRemoteImages(IMAGES)).toBe(1);
    expect(countRemoteImages('<img src="http://c/d.png"><img src="https://e/f.png">')).toBe(2);
    expect(countRemoteImages('<p>no images at all</p>')).toBe(0);
  });

  it('removes a data: image explicitly rather than letting the schema drop it', () => {
    const repaired = repairPastedHTML(IMAGES);
    // `allowBase64: false` would drop it silently; removing it here is the
    // documented behaviour, so the count of images is honest before parsing.
    expect(repaired).not.toContain('data:image');
    expect(repaired).not.toContain('alt="Inline"');
    // An <img> with no src is nothing to keep either.
    expect(repaired).not.toContain('alt="Broken"');
  });

  it('keeps a remote image and an already-stored idb: image', () => {
    const repaired = repairPastedHTML(IMAGES);
    expect(repaired).toContain('src="https://cdn.example.com/chart.png"');
    expect(repaired).toContain('src="idb:abc123"');

    const doc = pastedHTML(IMAGES);
    const srcs = nodesOfType(doc, 'image').map((n) => String(n.attrs?.src));
    expect(srcs).toEqual(['https://cdn.example.com/chart.png', 'idb:abc123']);
    // Dropping two images must not cost the prose around them.
    expectWordsSurvive({ html: IMAGES }, doc);
  });
});

// ============================================================= 9. Nested lists

describe('nested and mixed lists', () => {
  it('keeps three levels of ul → ol → ul', () => {
    const doc = pastedHTML(NESTED_LISTS);
    expect(maxNesting(doc, isList)).toBe(3);

    const outer = firstOfType(doc, 'bulletList')!;
    const middle = firstOfType(outer, 'orderedList')!;
    const inner = firstOfType(middle, 'bulletList')!;
    expect(docToText(inner)).toBe('Apples Spinach');
    expect(docToText(middle)).toContain('Dairy');
    expectWordsSurvive({ html: NESTED_LISTS }, doc);
  });

  it('keeps the siblings at every level', () => {
    const doc = pastedHTML(NESTED_LISTS);
    expect(nodesOfType(doc, 'listItem')).toHaveLength(6);
    expect(docToText(doc)).toBe('Groceries Produce Apples Spinach Dairy Hardware');
  });
});

// ======================================================= 10. Nested blockquotes

describe('deeply nested blockquotes', () => {
  it('survives five levels without throwing or losing a line', () => {
    expect(() => repairPastedHTML(DEEP_QUOTES)).not.toThrow();
    const doc = pastedHTML(DEEP_QUOTES);

    expect(maxNesting(doc, (n) => n.type === 'blockquote')).toBe(5);
    expect(nodesOfType(doc, 'blockquote')).toHaveLength(5);
    expect(nodesOfType(doc, 'paragraph').filter((n) => n.content?.length)).toHaveLength(5);
    expectWordsSurvive({ html: DEEP_QUOTES }, doc);
  });

  it('renders as five nested blockquotes for the reader', () => {
    const html = reader(pastedHTML(DEEP_QUOTES));
    expect(html.match(/<blockquote/g)).toHaveLength(5);
    expect(html).toContain('Level five said it first');
  });
});

// ==================================================================== 11. Tables

describe('tables', () => {
  it('becomes real table nodes, not a flattened run of cell text', () => {
    const doc = pastedHTML(TABLE);
    // GAUNTLET Round 1 Part 2 #4 shipped `cell A · cell B` for the whole table.
    // The outer table is structural now; only a nested one still flattens.
    expect(nodesOfType(doc, 'table')).toHaveLength(1);
    expect(nodesOfType(doc, 'tableRow')).toHaveLength(3);
    expect(nodesOfType(doc, 'tableHeader')).toHaveLength(2);
    expect(nodesOfType(doc, 'tableCell')).toHaveLength(6);
  });

  it('keeps colspan', () => {
    const doc = pastedHTML(TABLE);
    const headers = nodesOfType(doc, 'tableHeader');
    expect(headers.map((n) => n.attrs?.colspan)).toEqual([1, 2]);
  });

  it('reduces the nested table to text inside its host cell', () => {
    const doc = pastedHTML(TABLE);
    const host = nodesOfType(doc, 'tableCell').find((n) => docToText(n).includes('inner'));
    expect(host).toBeDefined();
    expect(docToText(host!)).toBe('inner left · inner right');
    // And it is text, not a second table.
    expect(nodesOfType(doc, 'table')).toHaveLength(1);
    expectWordsSurvive({ html: TABLE }, doc);
  });

  it('renders as a real table for the reader, colspan included', () => {
    const html = reader(pastedHTML(TABLE));
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toMatch(/colspan="2"/i);
    expect(html).toContain('inner left · inner right');
  });
});

// ================================================================== 12. Headings

describe('heading levels', () => {
  /*
   * The Round 1 regression, pinned. The schema has two heading levels because
   * the article's own `<h1>` is the title field, so a pasted `<h1>` used to be
   * demoted all the way to a paragraph and the structure of an imported draft
   * vanished. Remap, never drop.
   */
  it('maps h1→h2, h2→h2, h3→h3, h4/h5/h6→h3', () => {
    const doc = pastedHTML(HEADINGS);
    const headings = nodesOfType(doc, 'heading').map((n) => [docToText(n), n.attrs?.level]);
    expect(headings).toEqual([
      ['Alpha', 2],
      ['Bravo', 2],
      ['Charlie', 3],
      ['Delta', 3],
      ['Echo', 3],
      ['Foxtrot', 3],
    ]);
    expect(nodesOfType(doc, 'paragraph').filter((n) => n.content?.length)).toEqual([]);
    expectWordsSurvive({ html: HEADINGS }, doc);
  });

  it('never turns a pasted heading into a paragraph', () => {
    const doc = pastedHTML(HEADINGS);
    expect(nodesOfType(doc, 'heading')).toHaveLength(6);
    expect(repairPastedHTML(HEADINGS)).not.toContain('<h1');
    expect(repairPastedHTML(HEADINGS)).not.toContain('<h4');
    expect(repairPastedHTML(HEADINGS)).not.toContain('<h5');
    expect(repairPastedHTML(HEADINGS)).not.toContain('<h6');
  });
});
