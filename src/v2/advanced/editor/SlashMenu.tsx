import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  BlockPalette,
  filterBlocks,
  paletteOwnsKeys,
  usePaletteKeys,
  type BlockContext,
  type BlockType,
} from './BlockMenu';
import { slashKey, type SlashState } from './extensions';

const IDLE: SlashState = { active: false, from: 0, query: '' };

/**
 * `/` opens the same palette the `+` does, filtered as you type.
 *
 * It cannot live inside the `+`'s FloatingMenu: that menu only shows on an
 * *empty* block, and the moment you type `/f` the block is no longer empty and
 * the menu unmounts. So this anchors itself to the caret instead, and the two
 * routes share `BLOCK_TYPES` and `BlockPalette` rather than the container.
 */
export function SlashMenu({
  editor,
  onInsertImage,
}: {
  editor: Editor;
  onInsertImage: () => void;
}) {
  const [slash, setSlash] = useState<SlashState>(IDLE);
  const [active, setActive] = useState(0);
  /**
   * Escape dismisses the palette but leaves the `/` in the text, so the plugin
   * state stays active and would otherwise reopen on the next keystroke.
   * Remembering *which* slash was dismissed keeps it shut until the writer
   * starts a new one somewhere else.
   */
  const [dismissedFrom, setDismissedFrom] = useState<number | null>(null);
  const ctx = useMemo<BlockContext>(() => ({ insertImage: onInsertImage }), [onInsertImage]);

  /** Bumped by scroll/resize so the caret coordinates below are re-read. */
  const [, setTick] = useState(0);

  useEffect(() => {
    const sync = () => setSlash(slashKey.getState(editor.state) ?? IDLE);
    const reposition = () => setTick((n) => n + 1);
    sync();
    editor.on('transaction', sync);
    // A `position: fixed` box holds viewport coordinates, and scrolling
    // produces no transaction — without these the palette stays where the caret
    // used to be and can end up entirely below the fold.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      editor.off('transaction', sync);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [editor]);

  const items = useMemo(() => filterBlocks(slash.query), [slash.query]);

  // A narrowing query can leave the highlight past the end of the list.
  useEffect(() => setActive(0), [slash.query]);
  useEffect(() => {
    if (!slash.active) setDismissedFrom(null);
  }, [slash.active]);

  const open = slash.active && slash.from !== dismissedFrom;

  const close = useCallback(() => setDismissedFrom(slash.from), [slash.from]);

  const pick = useCallback(
    (i: number) => {
      const b: BlockType | undefined = items[i];
      if (!b) return;
      // Take the "/query" out first — the writer typed a command, not text.
      editor
        .chain()
        .focus()
        .deleteRange({ from: slash.from, to: slash.from + slash.query.length + 1 })
        .run();
      b.run(editor, ctx);
    },
    [editor, ctx, items, slash.from, slash.query.length],
  );

  const onKeys = usePaletteKeys({
    count: items.length,
    active,
    setActive,
    onPick: pick,
    onClose: close,
  });

  // Capture phase: the caret is still in the document, so ProseMirror would
  // otherwise move it on the arrow keys and split the block on Enter.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Not ours if the writer is typing into a field — see paletteOwnsKeys.
      if (!paletteOwnsKeys()) return;
      if (onKeys(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onKeys]);

  if (!open) return null;

  let coords: { left: number; bottom: number; top: number } | null = null;
  try {
    coords = editor.view.coordsAtPos(slash.from);
  } catch {
    // The position can be stale for one frame after an undo. Skip the frame
    // rather than throwing inside a render.
    coords = null;
  }
  if (!coords) return null;

  // Flip above the caret when there isn't room below, so the list is never
  // half off-screen on a short viewport. The threshold is the palette's own
  // max-height (`min(22rem, 60vh)` in editor.css) — a smaller number leaves a
  // band where it "fits" and is still clipped, and the pop's internal
  // overflow-y can't help when it is the element that is off-screen.
  const maxPop = Math.min(22 * 16, window.innerHeight * 0.6);
  const below = window.innerHeight - coords.bottom;
  const flip = below < maxPop && coords.top > below;

  return (
    <div
      className="slashmenu"
      style={{
        left: Math.min(coords.left, window.innerWidth - 300),
        ...(flip
          ? { bottom: window.innerHeight - coords.top + 6 }
          : { top: coords.bottom + 6 }),
      }}
    >
      <BlockPalette
        items={items}
        active={active}
        onActivate={setActive}
        onPick={(b) => pick(items.indexOf(b))}
        emptyLabel={`Nothing matches “${slash.query}”`}
      />
    </div>
  );
}
