// @vitest-environment jsdom
/**
 * The block contract.
 *
 * Every block type this editor offers has to survive the same journey: the
 * palette (or a markdown shorthand) creates it, Dexie stores it, `DocRenderer`
 * reads it back, undo unwinds it, the word count agrees about it, and a person
 * with no mouse can both make it and leave it. Each of those is a separate
 * place the editor's schema and the reader's switch statement can drift apart,
 * and a drift there is silent: the writer sees a table, the article shows a
 * sentence.
 *
 * So the tests are organised per block type rather than per feature, and the
 * round-trip case is the one that matters most — it is the only assertion that
 * fails when the two surfaces stop agreeing.
 *
 * `fake-indexeddb/auto` must precede anything that reaches `src/data/db`.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { BLOCK_TYPES, filterBlocks } from '../BlockMenu';
import { slashKey } from '../extensions';
import { countWords, docToText, isValidDoc } from '../../data/doc';
import { isBlankDoc } from '../../data/docguards';
import type { DocNode } from '../../data/types';
import {
  asDoc,
  blockType,
  canShowBlockMenu,
  doc,
  emptyDb,
  IMAGE_SRC,
  para,
  press,
  renderDoc,
  roundTrip,
  runBlock,
  type,
  withEditor,
} from './harness';

beforeEach(emptyDb);

// ---------------------------------------------------------------- the rig

describe('the rig itself', () => {
  /*
   * If this fails, every "markdown shorthand" test below is vacuous — it would
   * be asserting that typed text stays typed text. Guarded first, on purpose.
   */
  it('typing through handleTextInput fires input rules; insertContent does not', () => {
    const typed = withEditor((editor) => {
      type(editor, '## Section title');
      return asDoc(editor);
    });
    expect(typed.content?.[0]?.type).toBe('heading');

    const inserted = withEditor((editor) => {
      editor.commands.insertContent('## Section title');
      return asDoc(editor);
    });
    expect(inserted.content?.[0]?.type).toBe('paragraph');
  });

  it('press() reaches ProseMirror’s base keymap, not just TipTap shortcuts', () => {
    // Backspace-lifts-a-blockquote comes from the base keymap's joinBackward,
    // which no TipTap extension registers. Consuming it proves the whole
    // handleKeyDown chain is being walked.
    withEditor((editor) => {
      type(editor, '> Quoted words');
      editor.commands.setTextSelection(2);
      expect(press(editor, 'Backspace')).toBe(true);
      expect(editor.isActive('blockquote')).toBe(false);
    });
  });
});

// ------------------------------------------------------------ the spec table

interface BlockSpec {
  /** `BLOCK_TYPES` id. */
  id: string;
  title: string;
  /** The block command, run exactly as the palette runs it. */
  insert: (editor: Editor) => void;
  /** Text the fresh block can hold. Empty when the block holds none. */
  body: string;
  words: number;
  /** Typed shorthand including its trigger, or null when there is none. */
  shorthand: string | null;
  /** What the first node of the resulting document must be. */
  node: (node: DocNode) => void;
  /** Substrings the reader must emit for a round-tripped instance. */
  markup: string[];
  /** Extra state to establish before the undo test captures its baseline. */
  undoSetup?: (editor: Editor) => void;
}

const textNode = (text: string): DocNode => ({ type: 'text', text });

const SPECS: BlockSpec[] = [
  {
    id: 'paragraph',
    title: 'paragraph',
    insert: (e) => runBlock('paragraph', e),
    body: 'Plain words',
    words: 2,
    // The default block. There is nothing to type to get one, which is why
    // BLOCK_TYPES advertises no `markdown` hint for it.
    shorthand: null,
    node: (n) => expect(n).toEqual({ type: 'paragraph', content: [textNode('Plain words')] }),
    markup: ['<p>Plain words</p>'],
    // `setParagraph()` on an already-empty paragraph is a no-op, so the undo
    // test needs something for it to actually convert.
    undoSetup: (e) => runBlock('h2', e),
  },
  {
    id: 'h2',
    title: 'heading (h2)',
    insert: (e) => runBlock('h2', e),
    body: 'Section title',
    words: 2,
    shorthand: '## ',
    node: (n) =>
      expect(n).toEqual({
        type: 'heading',
        attrs: { level: 2 },
        content: [textNode('Section title')],
      }),
    markup: ['<h2>Section title</h2>'],
  },
  {
    id: 'h3',
    title: 'subheading (h3)',
    insert: (e) => runBlock('h3', e),
    body: 'Smaller title',
    words: 2,
    shorthand: '### ',
    node: (n) =>
      expect(n).toEqual({
        type: 'heading',
        attrs: { level: 3 },
        content: [textNode('Smaller title')],
      }),
    markup: ['<h3>Smaller title</h3>'],
  },
  {
    id: 'quote',
    title: 'blockquote',
    insert: (e) => runBlock('quote', e),
    body: 'Quoted words',
    words: 2,
    shorthand: '> ',
    node: (n) =>
      expect(n).toEqual({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [textNode('Quoted words')] }],
      }),
    markup: ['<blockquote class="doc-quote"', '<p>Quoted words</p>'],
  },
  {
    id: 'bullet',
    title: 'bullet list',
    insert: (e) => runBlock('bullet', e),
    body: 'Point one',
    words: 2,
    shorthand: '- ',
    node: (n) =>
      expect(n).toEqual({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [textNode('Point one')] }],
          },
        ],
      }),
    markup: ['<ul><li><p>Point one</p></li></ul>'],
  },
  {
    id: 'ordered',
    title: 'ordered list',
    insert: (e) => runBlock('ordered', e),
    body: 'First step',
    words: 2,
    shorthand: '1. ',
    node: (n) =>
      expect(n).toEqual({
        type: 'orderedList',
        attrs: { start: 1, type: null },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [textNode('First step')] }],
          },
        ],
      }),
    markup: ['<ol start="1"', '<li><p>First step</p></li>'],
  },
  {
    id: 'task',
    title: 'checklist',
    insert: (e) => runBlock('task', e),
    body: 'Ship it',
    words: 2,
    shorthand: '[] ',
    node: (n) =>
      expect(n).toEqual({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [textNode('Ship it')] }],
          },
        ],
      }),
    markup: ['<ul class="doc-tasks"', 'data-type="taskItem"', '<p>Ship it</p>'],
  },
  {
    id: 'code',
    title: 'code block',
    insert: (e) => runBlock('code', e),
    body: 'const x = 1',
    // Code is authored text and counts. See the word-count suite.
    words: 4,
    // The trailing space is the trigger: the rule is /^```([a-z]+)?[\s\n]$/.
    shorthand: '``` ',
    node: (n) =>
      expect(n).toEqual({
        type: 'codeBlock',
        attrs: { language: 'plaintext' },
        content: [textNode('const x = 1')],
      }),
    markup: ['<pre class="doc-code"', 'class="language-plaintext"', 'const x = 1'],
  },
  {
    id: 'divider',
    title: 'divider',
    insert: (e) => runBlock('divider', e),
    body: '',
    words: 0,
    shorthand: '---',
    node: (n) => expect(n).toEqual({ type: 'horizontalRule' }),
    markup: ['<hr'],
  },
  {
    id: 'image',
    title: 'image',
    /*
     * The palette entry's own `run` only calls `ctx.insertImage()` — the file
     * picker route owns the actual insert, because the node cannot exist until
     * bytes are in the local store. That callback is asserted separately; for
     * every other dimension the `idb:` node goes in directly, which is exactly
     * what `insertStored` in extensions.ts builds.
     */
    insert: (e) => {
      e.chain().focus().setImage({ src: IMAGE_SRC, alt: '', title: '' }).run();
    },
    body: '',
    words: 0,
    shorthand: null,
    node: (n) =>
      expect(n).toEqual({
        type: 'image',
        attrs: { src: IMAGE_SRC, alt: '', title: '', width: null, height: null },
      }),
    markup: ['<figure'],
  },
  {
    id: 'table',
    title: 'table',
    insert: (e) => runBlock('table', e),
    // The caret lands in the first header cell, so this types into the table.
    body: 'Cell text',
    words: 2,
    shorthand: null,
    node: (n) => {
      expect(n.type).toBe('table');
      const rows = n.content ?? [];
      // The palette promises "3 × 3, with a header row".
      expect(rows).toHaveLength(3);
      expect(rows[0].content?.map((c) => c.type)).toEqual([
        'tableHeader',
        'tableHeader',
        'tableHeader',
      ]);
      for (const row of rows.slice(1)) {
        expect(row.type).toBe('tableRow');
        expect(row.content?.map((c) => c.type)).toEqual([
          'tableCell',
          'tableCell',
          'tableCell',
        ]);
      }
      expect(rows[0].content?.[0].content).toEqual([
        { type: 'paragraph', content: [textNode('Cell text')] },
      ]);
    },
    markup: ['<table', 'Cell text'],
  },
];

/** The document a palette insert plus its body produces. */
function build(spec: BlockSpec): DocNode {
  return withEditor((editor) => {
    spec.insert(editor);
    if (spec.body) editor.commands.insertContent(spec.body);
    return asDoc(editor);
  });
}

/** The same block with nothing typed into it. */
function buildEmpty(spec: BlockSpec): DocNode {
  return withEditor((editor) => {
    spec.insert(editor);
    return asDoc(editor);
  });
}

/** The document the markdown shorthand produces, typed character by character. */
function buildTyped(spec: BlockSpec): DocNode {
  return withEditor((editor) => {
    type(editor, `${spec.shorthand ?? ''}${spec.body}`);
    return asDoc(editor);
  });
}

function specFor(id: string): BlockSpec {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`no BlockSpec for "${id}"`);
  return spec;
}

// -------------------------------------------------------------- per-block

for (const spec of SPECS) {
  describe(spec.title, () => {
    it('the block menu inserts it', () => {
      const first = build(spec).content?.[0];
      // Fail here rather than inside the per-block assertion if the palette
      // entry produced nothing at all.
      expect(first).toBeDefined();
      spec.node(first as DocNode);
    });

    if (spec.shorthand) {
      it(`the "${spec.shorthand.trim()}" shorthand produces the identical node`, () => {
        // Structural identity, not similarity: the two routes must be
        // indistinguishable in the stored document, attributes included.
        expect(buildTyped(spec)).toEqual(build(spec));
      });
    } else {
      it('has no markdown shorthand, and advertises none', () => {
        expect(blockType(spec.id).markdown).toBeUndefined();
      });
    }

    it('survives the round trip and renders in the reader', async () => {
      const built = build(spec);
      const stored = await roundTrip(built);

      expect(stored.content).toEqual(built);
      expect(isValidDoc(stored.content)).toBe(true);

      const html = renderDoc(stored.content);
      for (const fragment of spec.markup) expect(html).toContain(fragment);

      // The persisted count is derived from the same document the reader got.
      expect(stored.wordCount).toBe(spec.words);
    });

    it('one undo removes it; redo restores it exactly', () => {
      withEditor((editor) => {
        spec.undoSetup?.(editor);
        // Force the insert into its own history event so "one undo" is
        // deterministic, rather than depending on history's 500ms grouping
        // window and on how fast the test machine is.
        editor.view.dispatch(closeHistory(editor.state.tr));

        const before = JSON.stringify(asDoc(editor));
        spec.insert(editor);
        const after = JSON.stringify(asDoc(editor));
        expect(after).not.toBe(before);

        editor.commands.undo();
        expect(JSON.stringify(asDoc(editor))).toBe(before);

        editor.commands.redo();
        expect(JSON.stringify(asDoc(editor))).toBe(after);
      });
    });

    it('counts exactly the words a person authored', () => {
      expect(countWords(docToText(build(spec)))).toBe(spec.words);
    });

    it('an empty instance renders without throwing and counts zero words', () => {
      const empty = buildEmpty(spec);
      expect(() => renderDoc(empty)).not.toThrow();
      expect(renderDoc(empty)).not.toBe('');
      expect(countWords(docToText(empty))).toBe(0);
    });
  });
}

// ------------------------------------------------------- keyboard-only paths

/**
 * Every one of these goes through `press()`, i.e. the view's `handleKeyDown`
 * prop chain — the same path a real keydown takes. `keyboardShortcut()` was
 * the alternative and it reaches only extension-registered shortcuts, so it
 * would not have exercised the base keymap that half of these rely on.
 */
describe('keyboard-only authoring', () => {
  it('Enter at the end of a heading returns to a paragraph', () => {
    withEditor((editor) => {
      type(editor, '## Section title');
      expect(editor.isActive('heading', { level: 2 })).toBe(true);

      expect(press(editor, 'Enter')).toBe(true);
      expect(editor.isActive('heading')).toBe(false);
      expect(editor.isActive('paragraph')).toBe(true);

      type(editor, 'Body copy');
      expect(asDoc(editor).content?.[1]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Body copy' }],
      });
    });
  });

  it('Enter at the end of a subheading returns to a paragraph', () => {
    withEditor((editor) => {
      type(editor, '### Smaller title');
      expect(press(editor, 'Enter')).toBe(true);
      expect(editor.isActive('heading')).toBe(false);
      expect(editor.isActive('paragraph')).toBe(true);
    });
  });

  it('Enter twice leaves a bullet list', () => {
    withEditor((editor) => {
      type(editor, '- Point one');
      press(editor, 'Enter'); // new, empty item
      press(editor, 'Enter'); // lift out of the list
      expect(editor.isActive('bulletList')).toBe(false);
      expect(editor.state.selection.$from.depth).toBe(1);
      // The item that had words in it is untouched.
      expect(asDoc(editor).content?.[0].type).toBe('bulletList');
      expect(asDoc(editor).content?.[0].content).toHaveLength(1);
    });
  });

  it('Enter twice leaves an ordered list', () => {
    withEditor((editor) => {
      type(editor, '1. First step');
      press(editor, 'Enter');
      press(editor, 'Enter');
      expect(editor.isActive('orderedList')).toBe(false);
      expect(editor.state.selection.$from.depth).toBe(1);
    });
  });

  it('Enter twice leaves a checklist', () => {
    withEditor((editor) => {
      type(editor, '[] Ship it');
      press(editor, 'Enter');
      press(editor, 'Enter');
      expect(editor.isActive('taskList')).toBe(false);
      expect(editor.state.selection.$from.depth).toBe(1);
    });
  });

  it('Enter twice leaves a blockquote', () => {
    withEditor((editor) => {
      type(editor, '> Quoted words');
      press(editor, 'Enter');
      press(editor, 'Enter');
      expect(editor.isActive('blockquote')).toBe(false);
      expect(editor.state.selection.$from.depth).toBe(1);
      // Exactly one paragraph left inside the quote — the empty one was lifted
      // out, not duplicated.
      expect(asDoc(editor).content?.[0].content).toHaveLength(1);
    });
  });

  it('ArrowDown leaves a code block', () => {
    withEditor((editor) => {
      type(editor, '``` ');
      type(editor, 'const x = 1');
      expect(editor.isActive('codeBlock')).toBe(true);

      expect(press(editor, 'ArrowDown')).toBe(true);
      expect(editor.isActive('codeBlock')).toBe(false);
      expect(editor.isActive('paragraph')).toBe(true);
    });
  });

  it('Backspace at the start of a quote, list, checklist or code block lifts it', () => {
    const lifts = (shorthand: string, caret: number) =>
      withEditor((editor) => {
        type(editor, `${shorthand}Some words`);
        editor.commands.setTextSelection(caret);
        const handled = press(editor, 'Backspace');
        return { handled, doc: asDoc(editor) };
      });

    // The caret position is the first text offset inside the block: 2 once the
    // block wraps a paragraph, 3 once it wraps a list item's paragraph.
    for (const [shorthand, caret] of [
      ['> ', 2],
      ['- ', 3],
      ['1. ', 3],
      ['[] ', 3],
    ] as const) {
      const { handled, doc: after } = lifts(shorthand, caret);
      expect(handled).toBe(true);
      expect(after.content?.[0]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Some words' }],
      });
    }

    // A code block's text is a direct child, so its first offset is 1.
    withEditor((editor) => {
      type(editor, '``` ');
      type(editor, 'Some words');
      editor.commands.setTextSelection(1);
      expect(press(editor, 'Backspace')).toBe(true);
      expect(asDoc(editor).content?.[0]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Some words' }],
      });
    });
  });

  it('Backspace at the start of a heading rejoins the paragraph above it', () => {
    withEditor((editor) => {
      type(editor, 'Intro');
      press(editor, 'Enter');
      type(editor, '## Heading');
      editor.commands.setTextSelection(editor.state.selection.from - 'Heading'.length);

      expect(press(editor, 'Backspace')).toBe(true);
      expect(asDoc(editor).content?.[0]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'IntroHeading' }],
      });
    });
  });

  it('Backspace at the start of the first heading in a document is a no-op', () => {
    // Documented difference from the blocks above: `joinBackward` lifts a block
    // out of a *parent*, and a top-level heading at the very start of the
    // document has neither a parent to leave nor a block to join into. Asserted
    // rather than papered over, because the alternative — silently eating the
    // keystroke — would be the bug.
    withEditor((editor) => {
      type(editor, '## Heading');
      const before = JSON.stringify(asDoc(editor));
      editor.commands.setTextSelection(1);

      expect(press(editor, 'Backspace')).toBe(false);
      expect(JSON.stringify(asDoc(editor))).toBe(before);
      expect(editor.isActive('heading', { level: 2 })).toBe(true);
    });
  });

  it('Tab nests a bullet list item and Shift-Tab un-nests it', () => {
    withEditor((editor) => {
      type(editor, '- Point one');
      press(editor, 'Enter');
      type(editor, 'Point two');

      expect(press(editor, 'Tab')).toBe(true);
      const nested = asDoc(editor).content?.[0].content?.[0].content;
      expect(nested).toHaveLength(2);
      expect(nested?.[1].type).toBe('bulletList');

      expect(press(editor, 'Tab', { shift: true })).toBe(true);
      // Back to two siblings at the top level of the list.
      expect(asDoc(editor).content?.[0].content).toHaveLength(2);
      expect(asDoc(editor).content?.[0].content?.[0].content).toHaveLength(1);
    });
  });

  it('Tab nests a checklist item and Shift-Tab un-nests it', () => {
    withEditor((editor) => {
      type(editor, '[] Ship it');
      press(editor, 'Enter');
      type(editor, 'Then ship again');

      expect(press(editor, 'Tab')).toBe(true);
      expect(asDoc(editor).content?.[0].content?.[0].content?.[1].type).toBe('taskList');

      expect(press(editor, 'Tab', { shift: true })).toBe(true);
      expect(asDoc(editor).content?.[0].content).toHaveLength(2);
    });
  });

  it('Tab and Shift-Tab move between table cells, and ArrowDown leaves the table', () => {
    withEditor((editor) => {
      runBlock('table', editor);
      expect(editor.isActive('table')).toBe(true);

      press(editor, 'Tab');
      type(editor, 'Second');
      expect(press(editor, 'Tab', { shift: true })).toBe(true);
      type(editor, 'First');

      const header = asDoc(editor).content?.[0].content?.[0].content;
      expect(header?.[0].content).toEqual([
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
      ]);
      expect(header?.[1].content).toEqual([
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
      ]);

      // Tab through the remaining cells of the 3 × 3 without growing it, then
      // step out downwards. A grid you can enter and not leave is a trap.
      for (let i = 0; i < 8; i += 1) press(editor, 'Tab');
      expect(asDoc(editor).content?.[0].content).toHaveLength(3);
      expect(editor.isActive('table')).toBe(true);

      expect(press(editor, 'ArrowDown')).toBe(true);
      expect(editor.isActive('table')).toBe(false);
      expect(editor.isActive('paragraph')).toBe(true);
    });
  });

  it('a divider leaves the caret in the paragraph after it', () => {
    withEditor((editor) => {
      type(editor, '---');
      expect(editor.isActive('paragraph')).toBe(true);
      type(editor, 'After the rule');
      expect(asDoc(editor).content).toEqual([
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'After the rule' }] },
      ]);
    });
  });

  it('Enter next to a selected image gives a paragraph to keep writing in', () => {
    withEditor((editor) => {
      editor.chain().focus().setImage({ src: IMAGE_SRC, alt: '', title: '' }).run();
      // An inserted image is node-selected, which is what makes it reachable
      // and deletable from the keyboard in the first place.
      expect(editor.state.selection.empty).toBe(false);

      expect(press(editor, 'Enter')).toBe(true);
      expect(editor.isActive('paragraph')).toBe(true);
      type(editor, 'Caption-ish prose');
      const text = docToText(asDoc(editor));
      expect(text).toBe('Caption-ish prose');
      // The image itself survived being written around.
      expect(asDoc(editor).content?.some((n) => n.type === 'image')).toBe(true);
    });
  });

  it('a paragraph splits into another paragraph on Enter', () => {
    withEditor((editor) => {
      type(editor, 'Plain words');
      expect(press(editor, 'Enter')).toBe(true);
      type(editor, 'More plain words');
      expect(asDoc(editor).content?.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
    });
  });
});

// ------------------------------------------------------------- the block menu

describe('the block palette', () => {
  it('offers exactly one entry per block type, image and table included', () => {
    expect(BLOCK_TYPES.map((b) => b.id)).toEqual([
      'paragraph',
      'h2',
      'h3',
      'quote',
      'bullet',
      'ordered',
      'task',
      'code',
      'table',
      'divider',
      'image',
    ]);
    expect(new Set(BLOCK_TYPES.map((b) => b.id)).size).toBe(BLOCK_TYPES.length);
    // Every offered block is covered by the spec table above, and vice versa.
    expect([...BLOCK_TYPES.map((b) => b.id)].sort()).toEqual(
      [...SPECS.map((s) => s.id)].sort(),
    );
  });

  it('every entry has a label, a hint and a runnable command', () => {
    for (const block of BLOCK_TYPES) {
      expect(block.label.length).toBeGreaterThan(0);
      expect(block.hint.length).toBeGreaterThan(0);
      expect(typeof block.run).toBe('function');
    }
  });

  it('an empty query returns everything', () => {
    expect(filterBlocks('')).toEqual(BLOCK_TYPES);
    expect(filterBlocks('   ')).toEqual(BLOCK_TYPES);
  });

  it('"quo" finds Quote', () => {
    expect(filterBlocks('quo').map((b) => b.id)).toEqual(['quote']);
  });

  it('"todo" finds Checklist through its keywords, not its label', () => {
    expect(filterBlocks('todo').map((b) => b.id)).toEqual(['task']);
    expect(blockType('task').label.toLowerCase()).not.toContain('todo');
  });

  it('"zzz" finds nothing', () => {
    expect(filterBlocks('zzz')).toEqual([]);
  });
});

describe('the + affordance’s shouldShow predicate', () => {
  /*
   * Replicated in the harness because `shouldShow` is an inline arrow on
   * `<FloatingMenu>` and BlockMenu.tsx is out of scope for this change. Each
   * case drives a real selection into a real context rather than faking a
   * ProseMirror position, so the copy is at least being asked the same
   * questions the original is.
   */
  const cases: [name: string, setup: (editor: Editor) => void, shown: boolean][] = [
    ['an empty top-level paragraph', () => {}, true],
    ['an empty top-level heading', (e) => runBlock('h2', e), true],
    ['inside a list item', (e) => runBlock('bullet', e), false],
    ['inside a checklist item', (e) => runBlock('task', e), false],
    ['inside a blockquote', (e) => runBlock('quote', e), false],
    ['inside a code block', (e) => runBlock('code', e), false],
    ['inside a table cell', (e) => runBlock('table', e), false],
    ['on a non-empty paragraph', (e) => type(e, 'Plain words'), false],
  ];

  for (const [name, setup, shown] of cases) {
    it(`is ${shown} on ${name}`, () => {
      withEditor((editor) => {
        setup(editor);
        expect(canShowBlockMenu(editor)).toBe(shown);
      });
    });
  }

  it('is false when the selection is not collapsed', () => {
    withEditor((editor) => {
      type(editor, 'Plain words');
      editor.commands.selectAll();
      expect(canShowBlockMenu(editor)).toBe(false);
    });
  });
});

// ------------------------------------------------------------ the slash menu

describe('the slash command’s plugin state', () => {
  const slash = (editor: Editor) => slashKey.getState(editor.state);

  it('activates on "/" at the start of an empty top-level paragraph', () => {
    withEditor((editor) => {
      expect(slash(editor)?.active).toBe(false);
      type(editor, '/');
      expect(slash(editor)).toMatchObject({ active: true, query: '' });
    });
  });

  it('tracks the query as it is typed', () => {
    withEditor((editor) => {
      type(editor, '/head');
      expect(slash(editor)).toMatchObject({ active: true, query: 'head' });
      // ...and the query is what the palette filters on. Table is in the
      // result because `filterBlocks` searches hints too and Table's is
      // "3 × 3, with a header row" — surprising, but deliberate: the hint is
      // how someone finds a block they can't name. Pinned so a future change
      // to the hint text is a visible decision rather than a silent one.
      expect(filterBlocks(slash(editor)!.query).map((b) => b.id)).toEqual([
        'h2',
        'h3',
        'table',
      ]);
    });
  });

  it('deactivates as soon as a space is typed', () => {
    withEditor((editor) => {
      type(editor, '/head');
      expect(slash(editor)?.active).toBe(true);
      type(editor, ' ');
      // After "/head " the writer meant a slash, not a command.
      expect(slash(editor)?.active).toBe(false);
    });
  });

  it('never activates on a "/" mid-paragraph', () => {
    withEditor((editor) => {
      type(editor, 'Plain words /');
      expect(slash(editor)?.active).toBe(false);
      type(editor, 'head');
      expect(slash(editor)?.active).toBe(false);
    });
  });

  it('never activates inside a list item', () => {
    withEditor((editor) => {
      type(editor, '- Point one');
      press(editor, 'Enter');
      type(editor, '/');
      expect(slash(editor)?.active).toBe(false);
      // The "/" is still just a character in the document.
      expect(docToText(asDoc(editor))).toBe('Point one /');
    });
  });

  it('closes when the "/" is deleted, because it is derived from the document', () => {
    /*
     * Deleted through a command rather than through `press('Backspace')`:
     * removing one character mid-text is the browser's own contenteditable
     * behaviour, not a keymap binding, so headlessly there is nothing to
     * press. The state this plugin reads is the document either way.
     */
    withEditor((editor) => {
      type(editor, '/head');
      expect(slash(editor)?.active).toBe(true);
      // Delete just the "/" — the query text stays, the command does not.
      editor.commands.deleteRange({ from: 1, to: 2 });
      expect(docToText(asDoc(editor))).toBe('head');
      expect(slash(editor)?.active).toBe(false);
    });
  });

  it('closes on undo, for the same reason', () => {
    withEditor((editor) => {
      type(editor, '/head');
      expect(slash(editor)?.active).toBe(true);
      while (editor.can().undo()) editor.commands.undo();
      expect(docToText(asDoc(editor))).toBe('');
      expect(slash(editor)?.active).toBe(false);
    });
  });
});

// --------------------------------------------------------- schema drift guard

describe('the schema itself', () => {
  /*
   * DocRenderer has one switch arm per node type here, and an arm it has no
   * node for is dead code while a node it has no arm for renders as bare text.
   * Deleting or renaming anything below must break this test before it breaks
   * a reader's article.
   */
  it('holds exactly these nodes', () => {
    withEditor((editor) => {
      expect(Object.keys(editor.schema.spec.nodes.toObject()).sort()).toEqual([
        'blockquote',
        'bulletList',
        'codeBlock',
        'doc',
        'hardBreak',
        'heading',
        'horizontalRule',
        'image',
        'listItem',
        'orderedList',
        'paragraph',
        'table',
        'tableCell',
        'tableHeader',
        'tableRow',
        'taskItem',
        'taskList',
        'text',
      ]);
    });
  });

  it('holds exactly these marks', () => {
    withEditor((editor) => {
      expect(Object.keys(editor.schema.spec.marks.toObject()).sort()).toEqual([
        'bold',
        'code',
        'italic',
        'link',
        'strike',
        'underline',
      ]);
    });
  });

  it('accepts heading levels 2 and 3 only', () => {
    withEditor((editor) => {
      expect(editor.can().toggleHeading({ level: 2 })).toBe(true);
      expect(editor.can().toggleHeading({ level: 3 })).toBe(true);
      // The article's own <h1> is the title field, so the body starts at h2.
      expect(editor.can().toggleHeading({ level: 1 })).toBe(false);
      expect(editor.can().toggleHeading({ level: 4 })).toBe(false);
      expect(editor.can().toggleHeading({ level: 5 })).toBe(false);
      expect(editor.can().toggleHeading({ level: 6 })).toBe(false);
    });
  });

  it('has no input rule for "# " or "#### " either', () => {
    for (const shorthand of ['# ', '#### ']) {
      withEditor((editor) => {
        type(editor, `${shorthand}Title`);
        // Left as literal text rather than promoted or silently swallowed.
        expect(asDoc(editor).content?.[0]).toEqual({
          type: 'paragraph',
          content: [{ type: 'text', text: `${shorthand}Title` }],
        });
      });
    }
  });

  it('the reader clamps an out-of-range heading level to h2', () => {
    // A document written by an older build, or by a future backend, must not
    // produce an <h1> that competes with the article title.
    const html = renderDoc(
      doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Rogue' }] }),
    );
    expect(html).toBe('<h2>Rogue</h2>');
  });
});

// ------------------------------------------------------------ the word count

describe('the word-count rule', () => {
  /*
   * The documented rule, in two halves: all authored text counts, code blocks
   * included; metadata never counts. Both halves have to be pinned, because
   * "count everything in the JSON" and "count only prose" are each one small
   * edit away and each looks reasonable in isolation.
   */
  it('counts code, because code in a post is something a person wrote', () => {
    const code = withEditor((editor) => {
      runBlock('code', editor);
      editor.commands.insertContent('const total = items.length');
      return asDoc(editor);
    });
    expect(docToText(code)).toBe('const total = items.length');
    expect(countWords(docToText(code))).toBe(4);
  });

  it('counts prose across every block in a mixed document', () => {
    const mixed = withEditor((editor) => {
      type(editor, '## Two words');
      press(editor, 'Enter');
      type(editor, '> Three more words');
      press(editor, 'Enter');
      press(editor, 'Enter');
      type(editor, '- One');
      return asDoc(editor);
    });
    expect(countWords(docToText(mixed))).toBe(2 + 3 + 1);
  });

  it('an image’s alt and title contribute nothing', () => {
    const described = doc({
      type: 'image',
      attrs: {
        src: IMAGE_SRC,
        alt: 'a very long alternative description of the photograph',
        title: 'and a caption underneath it',
      },
    });
    expect(docToText(described)).toBe('');
    expect(countWords(docToText(described))).toBe(0);

    // Same picture, no metadata: identical count, so the metadata is inert.
    const bare = doc({ type: 'image', attrs: { src: IMAGE_SRC, alt: '', title: '' } });
    expect(countWords(docToText(described))).toBe(countWords(docToText(bare)));
  });

  it('a link’s href contributes nothing; its text still counts once', () => {
    const linked = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'here',
          marks: [
            {
              type: 'link',
              attrs: { href: 'https://example.com/a/very/long/path/with/many/segments' },
            },
          ],
        },
      ],
    });
    expect(docToText(linked)).toBe('here');
    expect(countWords(docToText(linked))).toBe(1);
  });

  it('a code block’s language contributes nothing', () => {
    const body = 'const x = 1';
    const counts = ['plaintext', 'typescript', 'javascript'].map((language) =>
      countWords(
        docToText(
          doc({ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: body }] }),
        ),
      ),
    );
    expect(counts).toEqual([4, 4, 4]);
  });

  it('an empty instance of every block type contributes zero words', () => {
    for (const spec of SPECS) {
      expect(countWords(docToText(buildEmpty(spec)))).toBe(0);
    }
  });
});

// ------------------------------------------------------ the data-loss guard

describe('isBlankDoc, the image-only-draft regression guard', () => {
  /*
   * An image-only draft used to be destroyed — bytes and all — the moment the
   * writer clicked away, because `wordCount === 0` was being read as "empty".
   * These are the cases that reopened that hole, one per node type that holds
   * no words.
   */
  it('an empty-paragraph document is blank', () => {
    expect(isBlankDoc(doc(para()))).toBe(true);
    expect(isBlankDoc(doc(para(''), para('   ')))).toBe(true);
  });

  it('a document with any words is not blank', () => {
    expect(isBlankDoc(doc(para('a')))).toBe(false);
  });

  it('an image-only document is NOT blank', () => {
    expect(isBlankDoc(buildEmpty(specFor('image')))).toBe(false);
  });

  it('a divider-only document is NOT blank', () => {
    expect(isBlankDoc(buildEmpty(specFor('divider')))).toBe(false);
  });

  it('a table-only document is NOT blank', () => {
    expect(isBlankDoc(buildEmpty(specFor('table')))).toBe(false);
  });

  it('every wordless block type still counts as content', () => {
    // The allow-list direction, swept across the whole palette: an empty
    // instance of anything except a bare paragraph has zero words and is still
    // content. A node type added tomorrow cannot silently reopen the hole.
    for (const spec of SPECS) {
      const empty = buildEmpty(spec);
      expect(countWords(docToText(empty))).toBe(0);
      const onlyAParagraph = spec.id === 'paragraph';
      expect(isBlankDoc(empty)).toBe(onlyAParagraph);
    }
  });
});

// -------------------------------------------------------- the image callback

describe('the image palette entry', () => {
  it('delegates to ctx.insertImage rather than touching the document', () => {
    withEditor((editor) => {
      const before = JSON.stringify(asDoc(editor));
      let calls = 0;
      runBlock('image', editor, { insertImage: () => (calls += 1) });

      expect(calls).toBe(1);
      // The node cannot exist until the file route has stored the bytes, so
      // the palette must not insert a placeholder in the meantime.
      expect(JSON.stringify(asDoc(editor))).toBe(before);
    });
  });

  it('an idb: image survives the round trip with its alt and caption', async () => {
    const described = doc({
      type: 'image',
      attrs: { src: IMAGE_SRC, alt: 'A photograph', title: 'Shot on a grey day' },
    });
    const stored = await roundTrip(described);

    expect(stored.content.content?.[0].attrs).toMatchObject({
      src: IMAGE_SRC,
      alt: 'A photograph',
      title: 'Shot on a grey day',
    });
    const html = renderDoc(stored.content);
    expect(html).toContain('<figure');
    // The caption is the one piece of image metadata the reader shows.
    expect(html).toContain('Shot on a grey day');
    expect(stored.wordCount).toBe(0);
  });
});
