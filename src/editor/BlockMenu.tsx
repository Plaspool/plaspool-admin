import { useEffect, useRef, useState } from 'react';
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
  Type,
} from 'lucide-react';

interface BlockType {
  id: string;
  label: string;
  hint: string;
  icon: typeof Type;
  /** Typed shorthand, shown so the menu teaches the shortcut. */
  markdown?: string;
  run: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
}

export const BLOCK_TYPES: BlockType[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    icon: Type,
    run: (e) => e.chain().focus().setParagraph().run(),
    isActive: (e) => e.isActive('paragraph'),
  },
  {
    id: 'h2',
    label: 'Heading',
    hint: 'Section title',
    icon: Heading2,
    markdown: '##',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Subheading',
    hint: 'Smaller title',
    icon: Heading3,
    markdown: '###',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (e) => e.isActive('heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Pull a passage out',
    icon: Quote,
    markdown: '>',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    isActive: (e) => e.isActive('blockquote'),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: 'Unordered points',
    icon: List,
    markdown: '-',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    isActive: (e) => e.isActive('bulletList'),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    hint: 'Ordered steps',
    icon: ListOrdered,
    markdown: '1.',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    isActive: (e) => e.isActive('orderedList'),
  },
  {
    id: 'task',
    label: 'Checklist',
    hint: 'Things to tick off',
    icon: ListTodo,
    markdown: '[]',
    run: (e) => e.chain().focus().toggleTaskList().run(),
    isActive: (e) => e.isActive('taskList'),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Monospaced, preformatted',
    icon: Code2,
    markdown: '```',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    isActive: (e) => e.isActive('codeBlock'),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Break between sections',
    icon: Minus,
    markdown: '---',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

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
  const wrapRef = useRef<HTMLDivElement>(null);

  // Wide screens have a left gutter to hang the + in. Narrow ones don't, so
  // it sits above the line instead of off-canvas.
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

  // Close on Escape or a click elsewhere; typing also dismisses it, because
  // the floating menu itself unmounts once the block is no longer empty.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        editor.commands.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, editor]);

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
          onClick={() => setOpen((o) => !o)}
        >
          <Plus className="ui-ic" aria-hidden="true" />
        </button>

        {open && (
          <div className="blockmenu__pop" role="menu">
            <p className="blockmenu__heading">Insert</p>
            {BLOCK_TYPES.map((b) => (
              <button
                key={b.id}
                role="menuitem"
                className="blockmenu__item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  b.run(editor);
                  setOpen(false);
                }}
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
            <span className="ui-menu__sep" />
            <button
              role="menuitem"
              className="blockmenu__item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onInsertImage();
              }}
            >
              <span className="blockmenu__icon">
                <ImageIcon className="ui-ic" aria-hidden="true" />
              </span>
              <span className="blockmenu__text">
                <span className="blockmenu__label">Image</span>
                <span className="blockmenu__hint">Upload from this device</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </FloatingMenu>
  );
}
