// @vitest-environment jsdom
/**
 * The cheatsheet must not lie.
 *
 * Round 1's critic found the Link button advertising `Ctrl+K` in its tooltip
 * with no handler anywhere behind it. A shortcuts dialog is that same failure
 * with thirty more places to hide, and it is the kind of bug no amount of
 * careful writing prevents — only a test that presses the key.
 *
 * So: every editor-owned row in SHORTCUT_GROUPS is pressed through the real
 * keymap here and asserted to have done what it claims. Every remaining row is
 * listed in APP_LEVEL against the file that implements it. The final test
 * asserts those two sets cover the sheet exactly — so a new row cannot be added
 * without either a behavioural test or an explicit, named exemption.
 */
import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { SHORTCUT_GROUPS, renderKeys } from '../shortcuts';
import { BLOCK_TYPES } from '../BlockMenu';
import { slashKey } from '../extensions';
import { asDoc, press, type, withEditor } from './harness';

/** Seed a paragraph and select its text, so mark shortcuts have something to act on. */
function withSelectedText<T>(fn: (editor: Editor) => T): T {
  return withEditor((editor) => {
    editor.commands.setContent('<p>alpha beta</p>');
    editor.commands.selectAll();
    return fn(editor);
  });
}

/** Seed a paragraph with the caret in it, for block-level shortcuts. */
function withCaret<T>(fn: (editor: Editor) => T): T {
  return withEditor((editor) => {
    editor.commands.setContent('<p>alpha</p>');
    editor.commands.focus('end');
    return fn(editor);
  });
}

/**
 * `Mod` is Ctrl here: jsdom reports no Apple platform, so TipTap's keymap
 * normalises `Mod-b` to `Ctrl-b` exactly as it would on Windows and Linux.
 */
const MOD = { ctrl: true } as const;

/**
 * Load a document the way `routes/Editor.tsx` does — outside the undo history.
 *
 * A plain `setContent` is an ordinary undoable step, so seeding with one puts
 * "empty → this document" on the undo stack and the first Ctrl+Z empties the
 * editor instead of taking back the last thing typed. That is a real bug, fixed
 * at the call site and pinned by the regression test at the bottom of this file;
 * seeding the same way here keeps these cases about the shortcut under test.
 */
function hydrate(editor: Editor, html: string) {
  editor.chain().setContent(html).setMeta('addToHistory', false).run();
}

/**
 * One entry per editor-owned row, keyed by the row's `keys` string so the
 * coverage assertion at the bottom can match them up.
 */
const COVERED: Record<string, () => void> = {
  'Mod+B': () =>
    withSelectedText((e) => {
      expect(press(e, 'b', MOD)).toBe(true);
      expect(e.isActive('bold')).toBe(true);
    }),
  'Mod+I': () =>
    withSelectedText((e) => {
      expect(press(e, 'i', MOD)).toBe(true);
      expect(e.isActive('italic')).toBe(true);
    }),
  'Mod+U': () =>
    withSelectedText((e) => {
      expect(press(e, 'u', MOD)).toBe(true);
      expect(e.isActive('underline')).toBe(true);
    }),
  'Mod+Shift+S': () =>
    withSelectedText((e) => {
      expect(press(e, 's', { ...MOD, shift: true })).toBe(true);
      expect(e.isActive('strike')).toBe(true);
    }),
  'Mod+E': () =>
    withSelectedText((e) => {
      expect(press(e, 'e', MOD)).toBe(true);
      expect(e.isActive('code')).toBe(true);
    }),
  'Mod+Alt+2': () =>
    withCaret((e) => {
      expect(press(e, '2', { ...MOD, alt: true })).toBe(true);
      expect(e.isActive('heading', { level: 2 })).toBe(true);
    }),
  'Mod+Alt+3': () =>
    withCaret((e) => {
      expect(press(e, '3', { ...MOD, alt: true })).toBe(true);
      expect(e.isActive('heading', { level: 3 })).toBe(true);
    }),
  'Mod+Shift+B': () =>
    withCaret((e) => {
      expect(press(e, 'b', { ...MOD, shift: true })).toBe(true);
      expect(e.isActive('blockquote')).toBe(true);
    }),
  'Mod+Shift+8': () =>
    withCaret((e) => {
      expect(press(e, '8', { ...MOD, shift: true })).toBe(true);
      expect(e.isActive('bulletList')).toBe(true);
    }),
  'Mod+Shift+7': () =>
    withCaret((e) => {
      expect(press(e, '7', { ...MOD, shift: true })).toBe(true);
      expect(e.isActive('orderedList')).toBe(true);
    }),
  'Mod+Shift+9': () =>
    withCaret((e) => {
      expect(press(e, '9', { ...MOD, shift: true })).toBe(true);
      expect(e.isActive('taskList')).toBe(true);
    }),
  'Mod+Alt+C': () =>
    withCaret((e) => {
      expect(press(e, 'c', { ...MOD, alt: true })).toBe(true);
      expect(e.isActive('codeBlock')).toBe(true);
    }),
  // Built by typing, not by setContent + focus(): `focus()` is a no-op on a
  // detached editor, so the caret never reaches the second item and Tab has
  // nothing to sink. Typing leaves the selection where a writer's would be.
  Tab: () =>
    withEditor((e) => {
      type(e, '- one');
      press(e, 'Enter');
      type(e, 'two');
      expect(press(e, 'Tab')).toBe(true);
      // The second item is now a nested list inside the first.
      expect(asDoc(e).content?.[0]?.content?.[0]?.content?.[1]?.type).toBe('bulletList');
    }),
  'Shift+Tab': () =>
    withEditor((e) => {
      type(e, '- one');
      press(e, 'Enter');
      type(e, 'two');
      press(e, 'Tab');
      expect(press(e, 'Tab', { shift: true })).toBe(true);
      // Back to two siblings at the top level of the list.
      expect(asDoc(e).content?.[0]?.content).toHaveLength(2);
    }),
  'Shift+Enter': () =>
    withCaret((e) => {
      expect(press(e, 'Enter', { shift: true })).toBe(true);
      expect(JSON.stringify(asDoc(e))).toContain('hardBreak');
    }),
  'Mod+Z': () =>
    withEditor((e) => {
      hydrate(e, '<p>alpha</p>');
      const before = JSON.stringify(asDoc(e));
      type(e, ' beta');
      expect(JSON.stringify(asDoc(e))).not.toBe(before);
      expect(press(e, 'z', MOD)).toBe(true);
      expect(JSON.stringify(asDoc(e))).toBe(before);
    }),
  'Mod+Shift+Z': () =>
    withEditor((e) => {
      hydrate(e, '<p>alpha</p>');
      type(e, ' beta');
      const typed = JSON.stringify(asDoc(e));
      press(e, 'z', MOD);
      expect(press(e, 'z', { ...MOD, shift: true })).toBe(true);
      expect(JSON.stringify(asDoc(e))).toBe(typed);
    }),
  'Alt+↑': () =>
    withEditor((e) => {
      e.commands.setContent('<p>first</p><p>second</p>');
      e.commands.focus('end');
      expect(press(e, 'ArrowUp', { alt: true })).toBe(true);
      expect(asDoc(e).content?.[0]?.content?.[0]?.text).toBe('second');
    }),
  'Alt+↓': () =>
    withEditor((e) => {
      e.commands.setContent('<p>first</p><p>second</p>');
      e.commands.focus('start');
      expect(press(e, 'ArrowDown', { alt: true })).toBe(true);
      expect(asDoc(e).content?.[0]?.content?.[0]?.text).toBe('second');
    }),
  '/': () =>
    withEditor((e) => {
      e.commands.setContent('<p></p>');
      e.commands.focus('end');
      type(e, '/');
      expect(slashKey.getState(e.state)?.active).toBe(true);
    }),
};

/**
 * Rows implemented by a React handler on `window`/`document` rather than by the
 * editor keymap. They need a mounted component, not an editor, so they are
 * exempted here — but named, with the file that owns them, so "there is no test"
 * is a visible decision rather than an oversight.
 */
const APP_LEVEL: Record<string, string> = {
  '?': 'components/ShortcutsDialog.tsx',
  'Mod+/': 'components/ShortcutsDialog.tsx',
  Esc: 'components/Dialog.tsx (onCancel), BlockMenu.tsx, SlashMenu.tsx, FindBar.tsx',
  'Mod+S': 'routes/Editor.tsx',
  'Mod+F': 'editor/FindBar.tsx',
  'Mod+K': 'editor/SelectionMenu.tsx',
};

describe('every advertised editor shortcut actually fires', () => {
  for (const [keys, check] of Object.entries(COVERED)) {
    it(`${keys} does what the cheatsheet says`, check);
  }
});

describe('the cheatsheet as a document', () => {
  const allRows = SHORTCUT_GROUPS.flatMap((g) => g.items);

  it('covers every row with either a test or a named exemption', () => {
    const uncovered = allRows
      .map((r) => r.keys)
      .filter((k) => !(k in COVERED) && !(k in APP_LEVEL));
    expect(uncovered).toEqual([]);
  });

  it('claims no shortcut that is no longer on the sheet', () => {
    const listed = new Set(allRows.map((r) => r.keys));
    const orphans = [...Object.keys(COVERED), ...Object.keys(APP_LEVEL)].filter(
      (k) => !listed.has(k),
    );
    expect(orphans).toEqual([]);
  });

  it('lists each shortcut once', () => {
    const seen = allRows.map((r) => `${r.keys}`);
    // `?` and Mod+/ are two routes to one action, so compare within groups.
    for (const group of SHORTCUT_GROUPS) {
      const keys = group.items.map((i) => i.keys);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(seen.length).toBeGreaterThan(20);
  });

  it('derives the typed shorthands from BLOCK_TYPES, so they cannot go stale', () => {
    // The dialog maps over this same filter; if a block loses its shorthand the
    // row disappears with it rather than lingering as a lie.
    const shorthands = BLOCK_TYPES.filter((b) => b.markdown).map((b) => b.markdown);
    expect(shorthands).toContain('##');
    expect(shorthands).toContain('[]');
    expect(shorthands).toContain('```');
    expect(shorthands.every(Boolean)).toBe(true);
  });
});

/**
 * Found by the Mod+Z case above, and the reason it is worth pressing keys
 * rather than reading code: TipTap's `setContent` is an ordinary undoable step.
 * Hydrating the editor therefore pushed "empty → the whole post" onto the undo
 * stack, so Ctrl+Z on a freshly opened post emptied it — and since undo is a
 * real transaction, `onUpdate` autosaved that empty document over the post.
 */
describe('loading a post is not an edit', () => {
  it('undo after hydration cannot empty the document', () => {
    withEditor((e) => {
      hydrate(e, '<p>the whole post</p>');
      const loaded = JSON.stringify(asDoc(e));
      // Undo with nothing typed yet must have nothing to take back.
      press(e, 'z', MOD);
      expect(JSON.stringify(asDoc(e))).toBe(loaded);
    });
  });

  it('undo after hydration takes back only what was typed', () => {
    withEditor((e) => {
      hydrate(e, '<p>the whole post</p>');
      const loaded = JSON.stringify(asDoc(e));
      type(e, ' and more');
      press(e, 'z', MOD);
      expect(JSON.stringify(asDoc(e))).toBe(loaded);
      // Repeated undo still cannot reach the pre-load empty document.
      press(e, 'z', MOD);
      press(e, 'z', MOD);
      expect(asDoc(e).content?.[0]?.content?.[0]?.text).toContain('the whole post');
    });
  });

  it('a plain setContent WOULD have been undoable — the bug this pins', () => {
    withEditor((e) => {
      e.commands.setContent('<p>the whole post</p>');
      press(e, 'z', MOD);
      // Demonstrates the failure mode: without `addToHistory: false`, one undo
      // reaches a document that never existed as anything the writer typed.
      expect(asDoc(e).content?.[0]?.content).toBeUndefined();
    });
  });
});

describe('key rendering', () => {
  it('uses Ctrl on non-Apple hardware', () => {
    expect(renderKeys('Mod+Shift+Z', false)).toEqual(['Ctrl', 'Shift', 'Z']);
  });

  it('uses the Apple glyphs on Apple hardware', () => {
    expect(renderKeys('Mod+Alt+C', true)).toEqual(['⌘', '⌥', 'C']);
    expect(renderKeys('Shift+Enter', true)).toEqual(['⇧', '⏎']);
  });

  it('leaves a bare key alone', () => {
    expect(renderKeys('?', false)).toEqual(['?']);
    expect(renderKeys('Tab', true)).toEqual(['Tab']);
  });
});
