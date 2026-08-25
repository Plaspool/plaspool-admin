import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { TextSelection } from '@tiptap/pm/state';
import { getFind, setFind } from './find';

/**
 * Ctrl/Cmd+F, scoped to the document.
 *
 * Takes the shortcut off the browser deliberately: the native find searches the
 * app chrome as well as the writing, can't replace, and happily "finds" text
 * inside a panel that isn't open. Escape hands the key back and returns the
 * caret to where the writer left it, so nothing is lost by trying it.
 */
export function FindBar({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState({ index: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where the caret was before the bar took focus, so Escape can put it back. */
  const caret = useRef(0);

  const push = useCallback(
    (patch: { query?: string; caseSensitive?: boolean; index?: number }) => {
      editor.view.dispatch(setFind(editor.state.tr, patch));
    },
    [editor],
  );

  useEffect(() => {
    const sync = () => {
      const f = getFind(editor.state);
      setCount({ index: f.matches.length ? f.index + 1 : 0, total: f.matches.length });
    };
    sync();
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  const close = useCallback(() => {
    setOpen(false);
    push({ query: '' });
    editor.chain().focus().setTextSelection(caret.current).run();
  }, [editor, push]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        caret.current = editor.state.selection.from;
        setOpen(true);
        // Opening on a selection searches for it, which is what every other
        // editor does and saves retyping the word you are looking at.
        const { from, to } = editor.state.selection;
        const picked = to > from ? editor.state.doc.textBetween(from, to, ' ') : '';
        const next = picked && picked.length < 80 ? picked : query;
        // Closing clears the plugin's query so the highlights go away, but the
        // field keeps its text. Re-pushing it on open is what stops the second
        // Ctrl+F showing a search term above "0 of 0" and disabled buttons.
        setQuery(next);
        push({ query: next, index: 0 });
        window.setTimeout(() => inputRef.current?.select(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, push, query]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const f = getFind(editor.state);
      if (!f.matches.length) return;
      const next = (f.index + dir + f.matches.length) % f.matches.length;
      const m = f.matches[next];
      const tr = setFind(editor.state.tr, { index: next });
      // Scroll the hit into view without stealing focus from the field.
      tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
      editor.view.dispatch(tr);
      inputRef.current?.focus();
    },
    [editor],
  );

  const replaceOne = useCallback(() => {
    const f = getFind(editor.state);
    const m = f.matches[f.index];
    if (!m) return;
    editor.view.dispatch(editor.state.tr.insertText(replacement, m.from, m.to));
    inputRef.current?.focus();
  }, [editor, replacement]);

  const replaceAll = useCallback(() => {
    const f = getFind(editor.state);
    if (!f.matches.length) return;
    const tr = editor.state.tr;
    // Back to front, so replacing one match cannot invalidate the positions of
    // the ones still to come. One transaction: one undo step, one autosave.
    for (const m of [...f.matches].reverse()) tr.insertText(replacement, m.from, m.to);
    editor.view.dispatch(tr);
    inputRef.current?.focus();
  }, [editor, replacement]);

  if (!open) return null;

  return (
    <div className="findbar" role="search" aria-label="Find in document">
      <div className="findbar__row">
        <input
          ref={inputRef}
          className="input findbar__field"
          value={query}
          placeholder="Find"
          aria-label="Find"
          onChange={(e) => {
            setQuery(e.target.value);
            push({ query: e.target.value, index: 0 });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        <span className="findbar__count" aria-live="polite">
          {query ? `${count.index} of ${count.total}` : ''}
        </span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => step(-1)}
          disabled={!count.total}
          aria-label="Previous match"
        >
          <ChevronUp className="ui-ic" aria-hidden="true" />
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => step(1)}
          disabled={!count.total}
          aria-label="Next match"
        >
          <ChevronDown className="ui-ic" aria-hidden="true" />
        </button>
        <button className="btn btn--ghost btn--sm" onClick={close} aria-label="Close find">
          <X className="ui-ic" aria-hidden="true" />
        </button>
      </div>

      <div className="findbar__row">
        <input
          className="input findbar__field"
          value={replacement}
          placeholder="Replace with"
          aria-label="Replace with"
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        <button className="btn btn--outline btn--sm" onClick={replaceOne} disabled={!count.total}>
          Replace
        </button>
        <button className="btn btn--outline btn--sm" onClick={replaceAll} disabled={!count.total}>
          All
        </button>
        <label className="findbar__case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => {
              setCaseSensitive(e.target.checked);
              push({ caseSensitive: e.target.checked, index: 0 });
            }}
          />
          Match case
        </label>
      </div>
    </div>
  );
}
