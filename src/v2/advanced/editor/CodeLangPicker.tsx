import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Select } from '../components/ui/Select';
import { CODE_LANGUAGES } from './extensions';

/**
 * The language a code block is highlighted as.
 *
 * A floating control rather than a node view: replacing CodeBlockLowlight's
 * node view would mean re-implementing the highlighting decorations inside
 * React, and the only thing that actually needs to be interactive is this one
 * field. It follows the caret, so it is present exactly when it applies and
 * costs nothing on a post with no code in it.
 */
export function CodeLangPicker({ editor }: { editor: Editor }) {
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [language, setLanguage] = useState('plaintext');

  useEffect(() => {
    const sync = () => {
      if (!editor.isActive('codeBlock')) {
        setBox(null);
        return;
      }
      setLanguage(String(editor.getAttributes('codeBlock').language || 'plaintext'));
      const { $from } = editor.state.selection;
      // Walk out to the code block itself; the caret is inside its text.
      let depth = $from.depth;
      while (depth > 0 && $from.node(depth).type.name !== 'codeBlock') depth -= 1;
      const dom = editor.view.nodeDOM($from.before(Math.max(depth, 1)));
      const el = dom instanceof HTMLElement ? dom : null;
      if (!el) {
        setBox(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setBox({ top: r.top + 6, right: window.innerWidth - r.right + 6 });
    };
    sync();
    editor.on('transaction', sync);
    editor.on('focus', sync);
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      editor.off('transaction', sync);
      editor.off('focus', sync);
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [editor]);

  if (!box) return null;

  return (
    <div className="codelang" style={{ top: box.top, right: box.right }}>
      <Select
        size="sm"
        label="Code language"
        value={language}
        options={CODE_LANGUAGES}
        onChange={(v) => {
          // `focus()` first so the command lands on the block the picker is
          // describing, not wherever focus went when the listbox opened.
          editor.chain().focus().updateAttributes('codeBlock', { language: v }).run();
        }}
      />
    </div>
  );
}
