import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { BLOCK_TYPES } from '../editor/BlockMenu';
import { SHORTCUT_GROUPS, isApple, renderKeys } from '../editor/shortcuts';

/**
 * The keyboard cheatsheet.
 *
 * Mounted once, above the router, because the shortcuts it describes are not a
 * property of any one route — and because the writer most likely to want it is
 * mid-sentence in the editor.
 *
 * Two ways in, deliberately. `?` is the convention, but it is unreachable in
 * this app precisely where it matters most: the caret is almost always inside
 * the prose, and a `?` that opened a dialog instead of typing a question mark
 * would be a bug, not a shortcut. So `?` works only when focus is not in a text
 * surface, and `Mod+/` — which no other binding here claims — works everywhere.
 */
const OPEN_EVENT = 'studio:shortcuts';

/** Lets any surface (a menu item, a button) raise the sheet without a context. */
export function openShortcuts() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const apple = isApple();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      // Mod+/ — reachable mid-sentence, which is the whole point.
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      // Bare `?`. Never while typing: a question mark must stay a question mark.
      if (e.key === '?' && !isTyping()) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      description={`Press ${apple ? '⌘' : 'Ctrl'}+/ any time, or ? when you aren’t typing.`}
      width="46rem"
      footer={
        <button className="btn btn--primary" onClick={() => setOpen(false)}>
          Close
        </button>
      }
    >
      <div className="keys">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="keys__group">
            <h3 className="keys__title">{group.title}</h3>
            <dl className="keys__list">
              {group.items.map((s) => (
                <div key={`${group.title}:${s.keys}`} className="keys__row">
                  <dt className="keys__combo">
                    {renderKeys(s.keys, apple).map((k, i) => (
                      <kbd key={i} className="keys__kbd">
                        {k}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="keys__label">
                    {s.label}
                    {s.note && <span className="keys__note"> — {s.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        {/* Derived from BLOCK_TYPES rather than retyped, so a block whose
            shorthand changes cannot leave a stale row behind here. */}
        <section className="keys__group">
          <h3 className="keys__title">Type at the start of a line</h3>
          <dl className="keys__list">
            {BLOCK_TYPES.filter((b) => b.markdown).map((b) => (
              <div key={b.id} className="keys__row">
                <dt className="keys__combo">
                  <kbd className="keys__kbd">{b.markdown}</kbd>
                  <span className="keys__then">then space</span>
                </dt>
                <dd className="keys__label">{b.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </Dialog>
  );
}
