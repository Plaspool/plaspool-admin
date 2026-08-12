import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import {
  Code2,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Plus,
  Quote,
  Table as TableIcon,
  Type,
} from 'lucide-react';

/** Everything a block needs that lives outside the editor. */
export interface BlockContext {
  insertImage: () => void;
}

export interface BlockType {
  id: string;
  label: string;
  hint: string;
  icon: typeof Type;
  /** Typed shorthand, shown so the menu teaches the shortcut. */
  markdown?: string;
  /** Extra words the slash filter should match — what people call the thing. */
  keywords?: string;
  run: (editor: Editor, ctx: BlockContext) => void;
  isActive?: (editor: Editor) => boolean;
}

export const BLOCK_TYPES: BlockType[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    icon: Type,
    keywords: 'body prose plain',
    run: (e) => e.chain().focus().setParagraph().run(),
    isActive: (e) => e.isActive('paragraph'),
  },
  {
    id: 'h2',
    label: 'Heading',
    hint: 'Section title',
    icon: Heading2,
    markdown: '##',
    keywords: 'title h2 section',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Subheading',
    hint: 'Smaller title',
    icon: Heading3,
    markdown: '###',
    keywords: 'title h3 subsection',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (e) => e.isActive('heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Pull a passage out',
    icon: Quote,
    markdown: '>',
    keywords: 'blockquote citation pull',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    isActive: (e) => e.isActive('blockquote'),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: 'Unordered points',
    icon: List,
    markdown: '-',
    keywords: 'ul unordered points',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    isActive: (e) => e.isActive('bulletList'),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    hint: 'Ordered steps',
    icon: ListOrdered,
    markdown: '1.',
    keywords: 'ol numbered steps',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    isActive: (e) => e.isActive('orderedList'),
  },
  {
    id: 'task',
    label: 'Checklist',
    hint: 'Things to tick off',
    icon: ListTodo,
    markdown: '[]',
    keywords: 'todo task checkbox tick',
    run: (e) => e.chain().focus().toggleTaskList().run(),
    isActive: (e) => e.isActive('taskList'),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Monospaced, preformatted',
    icon: Code2,
    markdown: '```',
    keywords: 'snippet syntax pre monospace',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    isActive: (e) => e.isActive('codeBlock'),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '3 × 3, with a header row',
    icon: TableIcon,
    keywords: 'grid rows columns cells',
    run: (e) =>
      e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    isActive: (e) => e.isActive('table'),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Break between sections',
    icon: Minus,
    markdown: '---',
    keywords: 'rule hr separator break',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    // Lives in the list rather than beside it so `/` and `+` offer exactly the
    // same set — an item only one of them knows about is how they drift.
    id: 'image',
    label: 'Image',
    hint: 'Upload from this device',
    icon: ImageIcon,
    keywords: 'photo picture figure upload',
    run: (_e, ctx) => ctx.insertImage(),
  },
];

/**
 * Ranked, not merely filtered.
 *
 * A plain substring match over label + hint + keywords put **Text** first for
 * `/h`, because "Plain paragraph" contains an h — so the most obvious shortcut
 * in the app inserted the wrong block on Enter. A name the writer is typing the
 * start of beats a coincidence buried in a description.
 */
export function filterBlocks(query: string): BlockType[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_TYPES;
  const rank = (b: BlockType): number => {
    const label = b.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if ((b.keywords ?? '').toLowerCase().split(/\s+/).some((k) => k.startsWith(q))) return 2;
    return 3;
  };
  return BLOCK_TYPES.map((b) => ({ b, r: rank(b), i: BLOCK_TYPES.indexOf(b) }))
    .filter(
      ({ b, r }) =>
        r < 3 ||
        `${b.hint} ${b.keywords ?? ''} ${b.markdown ?? ''}`.toLowerCase().includes(q),
    )
    // Stable within a rank, so the list keeps its authored order.
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(({ b }) => b);
}

/**
 * The palette itself, shared by the `+` and by `/`.
 *
 * It owns its own keyboard model because the two callers give it focus
 * differently: the `+` moves focus into the list, while `/` leaves the caret in
 * the document and the list is driven at a distance. Either way the same
 * `active` index decides what Enter picks, so the two routes cannot diverge.
 */
export function BlockPalette({
  items,
  active,
  onActivate,
  onPick,
  emptyLabel = 'No blocks match',
  focusItems = false,
}: {
  items: BlockType[];
  active: number;
  onActivate: (i: number) => void;
  onPick: (b: BlockType) => void;
  emptyLabel?: string;
  focusItems?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible when the query narrows a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
    if (focusItems) el?.focus();
  }, [active, focusItems, items]);

  if (!items.length) {
    return (
      <div className="blockmenu__pop" role="menu" aria-label="Insert a block">
        <p className="blockmenu__empty">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="blockmenu__pop" role="menu" aria-label="Insert a block" ref={listRef}>
      <p className="blockmenu__heading">Insert</p>
      {items.map((b, i) => (
        <button
          key={b.id}
          role="menuitem"
          type="button"
          className={`blockmenu__item${i === active ? ' is-active' : ''}`}
          data-active={i === active}
          // Roving tabindex: one stop for the whole menu, arrows move within it.
          tabIndex={focusItems ? (i === active ? 0 : -1) : -1}
          onMouseEnter={() => onActivate(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(b)}
        >
          <span className="blockmenu__icon">
            <b.icon className="ui-ic" aria-hidden="true" />
          </span>
          <span className="blockmenu__text">
            <span className="blockmenu__label">{b.label}</span>
            <span className="blockmenu__hint">{b.hint}</span>
          </span>
          {b.markdown && <kbd className="blockmenu__kbd">{b.markdown}</kbd>}
        </button>
      ))}
    </div>
  );
}

/**
 * Whether a palette may answer for the keystroke that just happened.
 *
 * Both palettes listen on `document` in the **capture** phase — that is how they
 * beat ProseMirror to the arrow keys. It also means that without this gate they
 * answer for keys typed into anything else on screen: with the `+` palette open
 * and the caret in the find field, ArrowDown/ArrowDown/Enter — a plain "next
 * match" gesture — silently turned the paragraph into a Subheading.
 */
export function paletteOwnsKeys(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return true;
  if (el.closest?.('.blockmenu, .slashmenu')) return true;
  return !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Arrow/Home/End/Enter/Escape over a palette. Returns true when it consumed the
 * key, so the caller can decide whether to preventDefault — the `+` wants to,
 * and so does `/`, because otherwise the arrows would move the caret instead.
 */
export function usePaletteKeys({
  count,
  active,
  setActive,
  onPick,
  onClose,
}: {
  count: number;
  active: number;
  setActive: (i: number) => void;
  onPick: (i: number) => void;
  onClose: () => void;
}) {
  return useCallback(
    (e: KeyboardEvent): boolean => {
      switch (e.key) {
        case 'ArrowDown':
          setActive(count ? (active + 1) % count : 0);
          return true;
        case 'ArrowUp':
          setActive(count ? (active - 1 + count) % count : 0);
          return true;
        case 'Home':
          setActive(0);
          return true;
        case 'End':
          setActive(Math.max(0, count - 1));
          return true;
        case 'Enter':
        case 'Tab':
          if (!count) return false;
          onPick(active);
          return true;
        case 'Escape':
          onClose();
          return true;
        default:
          return false;
      }
    },
    [count, active, setActive, onPick, onClose],
  );
}

/**
 * The insert affordance, Medium-style: a `+` sits beside the empty block the
 * caret is on. Clicking it opens the block palette in place.
 *
 * This replaces a permanently docked toolbar. A writer looking at a blank
 * page should see the page, not a control panel — the controls come to the
 * line they are actually on.
 */
export function BlockMenu({
  editor,
  onInsertImage,
}: {
  editor: Editor;
  onInsertImage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctx = useMemo<BlockContext>(() => ({ insertImage: onInsertImage }), [onInsertImage]);

  // Wide screens have a left gutter to hang the + in. Narrow ones don't, so
  // it sits above the line instead of off-canvas.
  //
  // LEFT is load-bearing rather than incidental. The drag handle defaulted to
  // the same `left-start` and the two drew in the same spot on an empty
  // paragraph, which is the only state that shows both. The handle took the
  // right gutter (`DRAG_HANDLE_POSITION` in Editor.tsx) and the + kept this
  // side, because it marks where the new block will land and that is also
  // where `/` opens its palette. Placing this on the right brings the overlap
  // back, in the other gutter.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 720,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 719px)');
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    editor.commands.focus();
  }, [editor]);

  const pick = useCallback(
    (i: number) => {
      const b = BLOCK_TYPES[i];
      if (!b) return;
      setOpen(false);
      b.run(editor, ctx);
    },
    [editor, ctx],
  );

  const onKeys = usePaletteKeys({
    count: BLOCK_TYPES.length,
    active,
    setActive,
    onPick: pick,
    onClose: close,
  });

  // Close on Escape or a click elsewhere; typing also dismisses it, because
  // the floating menu itself unmounts once the block is no longer empty.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!paletteOwnsKeys()) return;
      if (onKeys(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Focus can leave without a click — Ctrl+F is the case that matters. An
    // open palette that nothing is pointing at is just a trap for keystrokes.
    const onFocus = (e: FocusEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, onKeys]);

  return (
    <FloatingMenu
      editor={editor}
      options={{ placement: narrow ? 'top-start' : 'left-start', offset: narrow ? 6 : 12 }}
      shouldShow={({ editor: e, state }) => {
        const { $from, empty } = state.selection;
        if (!empty || !e.isEditable) return false;
        // Only on a genuinely empty top-level text block — not inside lists,
        // quotes or code, where a `+` would be ambiguous.
        const parent = $from.parent;
        return (
          parent.content.size === 0 &&
          (parent.type.name === 'paragraph' || parent.type.name === 'heading') &&
          $from.depth === 1
        );
      }}
    >
      <div className="blockmenu" ref={wrapRef}>
        <button
          type="button"
          className={`blockmenu__plus${open ? ' is-open' : ''}`}
          aria-label={open ? 'Close block menu' : 'Insert a block'}
          aria-expanded={open}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setActive(0);
            setOpen((o) => !o);
          }}
        >
          <Plus className="ui-ic" aria-hidden="true" />
        </button>

        {open && (
          <BlockPalette
            items={BLOCK_TYPES}
            active={active}
            onActivate={setActive}
            onPick={(b) => pick(BLOCK_TYPES.indexOf(b))}
            focusItems
          />
        )}
      </div>
    </FloatingMenu>
  );
}
