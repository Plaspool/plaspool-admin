import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert } from 'lucide-react';

/**
 * The contextual save bar — the dark "Unsaved changes · Discard · Save" pill
 * that takes the topbar's centre slot while a form is dirty, the reference
 * admin's own move. A portal, because the screens render inside the shell's
 * scroll area and this belongs to the application chrome.
 *
 * WHILE THE BAR IS UP, CLOSING THE TAB ASKS FIRST. `beforeunload` is wired to
 * exactly the same condition that shows the bar, so the browser's "leave
 * site?" dialog and the pill can never disagree about whether anything is at
 * stake. (In-app navigation is not blocked — the screens are small enough
 * that guarding every link would cost more than the occasional lost edit; the
 * bar makes the state visible, which is the part that prevents most of them.)
 */
export function SaveBar({
  when,
  label = 'Unsaved changes',
  saving = false,
  disabled = false,
  saveLabel = 'Save',
  onDiscard,
  onSave,
}: {
  when: boolean;
  label?: string;
  saving?: boolean;
  /** Blocks Save without hiding it — a validation problem is something the
   *  bar should show, not something it should vanish over. */
  disabled?: boolean;
  saveLabel?: string;
  onDiscard: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    if (!when) return;
    function guard(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [when]);

  if (!when) return null;

  return createPortal(
    <div className="savebar" role="status" aria-label={label}>
      <CircleAlert aria-hidden="true" />
      <span className="savebar__label">{label}</span>
      <button type="button" className="savebar__btn savebar__btn--ghost" onClick={onDiscard} disabled={saving}>
        Discard
      </button>
      <button
        type="button"
        className="savebar__btn savebar__btn--save"
        onClick={onSave}
        disabled={disabled || saving}
      >
        {saving ? <span className="spinner" aria-hidden="true" /> : null}
        {saveLabel}
      </button>
    </div>,
    document.body,
  );
}
