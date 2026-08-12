// @vitest-environment jsdom
/**
 * The two gutter controls stay on opposite sides.
 *
 * The `+` and the drag handle were both placed `left-start` — the `+` by
 * `BlockMenu.tsx`, the handle by `@tiptap/extension-drag-handle`'s default,
 * which is what passing no config gets you. On an empty top-level paragraph,
 * the one state that shows both at once, they resolved to the same point and
 * whichever lost the stacking order could not be clicked. The fix gives them a
 * gutter each: `+` left, grip right.
 *
 * That fix is two string literals in two files that have no reason to know
 * about each other, and its failure mode is silent — a handle back under the +
 * looks like nothing at all until someone tries to grab one. Hence this file.
 *
 * IT READS SOURCE TEXT, AND THAT IS THE POINT. Floating-ui resolves a placement
 * against measured rectangles; in jsdom every rectangle is 0×0, so a mounted
 * handle reports identical coordinates whichever gutter it was configured for —
 * a test that rendered one and read its position would pass just as happily
 * with the placement deleted. `brand.test.tsx` and `sw.test.ts` pin their files
 * the same way and for the same reason: what is under test is a static
 * declaration, so the test reads the declaration.
 *
 * The one behavioural claim, at the bottom, is Alt+↑/↓ — the route that needs
 * no gutter at all, and the reason moving this control is safe.
 *
 * NOT COVERED HERE: `editor.css`'s side of the same change (the margin that
 * flipped with the handle, the `.editor__page:hover` reveal, the coarse-pointer
 * `display: none`). Vitest runs with `css: false`, and its `vitest:css-disable`
 * plugin rewrites EVERY id matching `\.css($|\?)` to an empty module — `?raw`
 * included, measured: the import arrives as a 0-length string. Turning that on
 * is a `vitest.config.ts` change, which is shared. Those three rules are on the
 * browser checklist instead.
 */
import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
// Vite's `?raw`, per the note in `src/brand.test.tsx`: this project's tsconfig
// types are `["vite/client"]` only, so Node builtins do not typecheck in `src/`.
// `?raw` is declared by vite/client and reads the real file at transform time.
import blockMenuSource from '../BlockMenu.tsx?raw';
import editorRouteSource from '../../routes/Editor.tsx?raw';
import { asDoc, press, withEditor } from './harness';

/**
 * The props of the rendered `<DragHandle …>`, as written.
 *
 * Found by its `editor` prop rather than by being first in the file, because
 * the comment above the constant names the component too and prose is source as
 * far as a regex is concerned. A JSX opening tag holds no `>`, so `[^>]*` stops
 * in the right place.
 */
function dragHandleProps(): string {
  const props = [...editorRouteSource.matchAll(/<DragHandle\s+([^>]*)>/g)]
    .map((m) => m[1])
    .find((p) => p.includes('editor={editor}'));
  if (props === undefined) throw new Error('Editor.tsx no longer renders a <DragHandle>');
  return props;
}

/**
 * The placement the handle is given, read off its constant.
 *
 * Anchored to the declaration on purpose: the comment beside it quotes the
 * package default (`placement: 'left-start'`) verbatim, and a looser match
 * would happily return that instead.
 */
function gripPlacement(): string {
  const declared = /DRAG_HANDLE_POSITION\s*=\s*\{[^}]*placement:\s*'([^']+)'/.exec(
    editorRouteSource,
  );
  if (!declared) throw new Error('Editor.tsx no longer declares DRAG_HANDLE_POSITION');
  return declared[1];
}

/** Both branches of the `+`'s placement — the narrow one and the wide one. */
function plusPlacements(): string[] {
  const options = /<FloatingMenu[\s\S]*?options=\{\{([^}]*)\}\}/.exec(blockMenuSource);
  if (!options) throw new Error('BlockMenu.tsx no longer passes options to its FloatingMenu');
  return [...options[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** `left` / `right` / `top` — the gutter a floating-ui placement lands in. */
const side = (placement: string) => placement.split('-')[0];

describe('the drag handle is configured into the right gutter', () => {
  it('its placement constant says right-start', () => {
    expect(gripPlacement()).toBe('right-start');
  });

  it('and the DragHandle is actually given it', () => {
    // The constant alone proves nothing: unused, the handle falls back to the
    // package default, which is the left gutter this change was made to leave.
    expect(dragHandleProps()).toContain('computePositionConfig={DRAG_HANDLE_POSITION}');
  });

  it('the config is a module constant, not a literal in the JSX', () => {
    // `<DragHandle>` lists `computePositionConfig` in the dependency array of
    // the effect that calls `editor.registerPlugin`, and this route re-renders
    // on every keystroke, so a fresh literal per render would unregister and
    // re-register the ProseMirror plugin on each one.
    expect(dragHandleProps()).not.toMatch(/computePositionConfig=\{\s*\{/);
    expect(editorRouteSource).toMatch(/^const DRAG_HANDLE_POSITION\s*=/m);
  });
});

describe('the + keeps the left gutter', () => {
  it('wide screens put it left-start, narrow ones above the line', () => {
    expect(plusPlacements()).toEqual(['top-start', 'left-start']);
  });

  it('neither control names the other one’s side', () => {
    // The invariant the whole change exists for, stated once. Whatever these
    // two placements become, they must not name one gutter between them again.
    expect(plusPlacements().map(side)).not.toContain('right');
    expect(side(gripPlacement())).toBe('right');
  });
});

describe('the route that needs no gutter is untouched', () => {
  /*
   * Load-bearing for everything above. The grip may be moved across the page,
   * and hidden outright on coarse pointers, only because it is not the only way
   * to reorder a block. `shortcuts.test.tsx` presses these keys to prove the
   * cheatsheet is honest; they are pressed again here to prove the gutter split
   * did not quietly make the pointer the only route.
   */
  const twoBlocks = '<p>first</p><p>second</p>';
  const firstText = (editor: Editor) => asDoc(editor).content?.[0]?.content?.[0]?.text;

  it('Alt+↑ still moves a block up', () => {
    withEditor((editor) => {
      editor.commands.setContent(twoBlocks);
      editor.commands.focus('end');
      expect(press(editor, 'ArrowUp', { alt: true })).toBe(true);
      expect(firstText(editor)).toBe('second');
    });
  });

  it('Alt+↓ still moves a block down', () => {
    withEditor((editor) => {
      editor.commands.setContent(twoBlocks);
      editor.commands.focus('start');
      expect(press(editor, 'ArrowDown', { alt: true })).toBe(true);
      expect(firstText(editor)).toBe('second');
    });
  });
});
