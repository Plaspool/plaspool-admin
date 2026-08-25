import { useCallback, useEffect, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Italic,
  Link2,
  Quote,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { Dialog } from '../components/Dialog';

/**
 * Formatting appears where the text is, only when text is selected.
 *
 * The previous fixed toolbar sat over the prose column at every scroll
 * position and was on screen even when nothing was selectable. This is the
 * Medium behaviour: select, format, carry on.
 */
export function SelectionMenu({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');

  const openLink = useCallback(() => {
    setLinkValue(editor.getAttributes('link').href ?? '');
    setLinkOpen(true);
  }, [editor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (editor.state.selection.empty && !editor.isActive('link')) return;
        e.preventDefault();
        openLink();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor, openLink]);

  const applyLink = useCallback(() => {
    const raw = linkValue.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!raw) chain.unsetLink().run();
    else {
      const href = /^(https?:|mailto:)/i.test(raw) ? raw : `https://${raw}`;
      chain.setLink({ href }).run();
    }
    setLinkOpen(false);
  }, [editor, linkValue]);

  const Btn = ({
    label,
    active,
    onClick,
    children,
    kbd,
  }: {
    label: string;
    active?: boolean;
    onClick: () => void;
    children: React.ReactNode;
    kbd?: string;
  }) => (
    <button
      type="button"
      className={`bubble__btn${active ? ' is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={kbd ? `${label} · ${kbd}` : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );

  return (
    <>
      <BubbleMenu
        editor={editor}
        options={{ placement: 'top', offset: 10 }}
        shouldShow={({ editor: e, state }) => {
          const { empty } = state.selection;
          // No bubble over images or code — neither takes inline marks.
          if (e.isActive('image') || e.isActive('codeBlock')) return false;
          return !empty && e.isEditable;
        }}
      >
        <div className="bubble" role="toolbar" aria-label="Format selection">
          <Btn
            label="Bold"
            kbd="Ctrl+B"
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Italic"
            kbd="Ctrl+I"
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Underline"
            kbd="Ctrl+U"
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Strikethrough"
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Inline code"
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn label="Link" kbd="Ctrl+K" active={editor.isActive('link')} onClick={openLink}>
            <Link2 className="ui-ic" aria-hidden="true" />
          </Btn>

          <span className="bubble__sep" aria-hidden="true" />

          <Btn
            label="Heading"
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Subheading"
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className="ui-ic" aria-hidden="true" />
          </Btn>
          <Btn
            label="Quote"
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote className="ui-ic" aria-hidden="true" />
          </Btn>
        </div>
      </BubbleMenu>

      <Dialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Link"
        description="Paste a URL, or clear the field to remove the link."
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setLinkOpen(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={applyLink}>
              Apply
            </button>
          </>
        }
      >
        <input
          className="input"
          autoFocus
          value={linkValue}
          placeholder="example.com/article"
          onChange={(e) => setLinkValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyLink();
            }
          }}
        />
      </Dialog>
    </>
  );
}
