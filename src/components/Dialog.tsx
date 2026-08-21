import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import './dialog.css';

/**
 * Native <dialog> for correct focus trapping and the top layer, restyled
 * entirely to the design system — no browser-default chrome anywhere.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = '28rem',
  sheet = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  /**
   * Rise from the bottom edge on a phone instead of floating in the middle.
   *
   * For dialogs an operator opens repeatedly with one hand — a pickup being
   * scheduled, a quantity being counted in a warehouse. A centred panel puts its
   * fields under the thumb's reach and its buttons above it; a sheet puts both
   * where the thumb already is. Inert above 640px, and it is the same element
   * either way, so the native `<dialog>` focus trap and the top layer are
   * unchanged — this is a class, not a second dialog.
   */
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  /**
   * THE VISIBLE TITLE IS THE DIALOG'S NAME, WIRED RATHER THAN COPIED.
   *
   * A modal `<dialog>` carrying no `aria-labelledby`, `aria-label` or `title` is
   * announced as "dialog" and nothing more — and the surfaces this one element
   * carries are a shipment being created, an order being cancelled and a post
   * being deleted, where "dialog" is the single least useful word available.
   * Measured before this line existed: `hasAriaLabelledby false, hasAriaLabel
   * false, role null, :modal true`, on every dialog in the app at once.
   *
   * `aria-label` WAS THE OTHER OPTION AND IT IS WORSE TWICE. It restates a
   * string that is already on screen, so the spoken name and the printed one
   * drift the first time a caller edits only the visible half; and a dialog
   * named by an attribute still needs the `<h2>` for the heading list a screen
   * reader user navigates a long dialog by, so the app would be maintaining two
   * titles to say one thing. Pointing at the heading keeps exactly one.
   *
   * AN EMPTY TITLE GETS NO NAME RATHER THAN AN EMPTY ONE. `aria-labelledby`
   * aimed at an empty `<h2>` computes to `""`, which is not "unnamed" — it is a
   * name the browser will not fall back from, so the dialog ends up worse off
   * than with no attribute at all. `title` is a required prop and every call
   * site in this repo passes a real one; this is the guard for the day one
   * passes a value that is empty at runtime.
   */
  const titleId = useId();
  const named = typeof title === 'string' && title.trim() !== '';

  /**
   * A MODAL DIALOG IS `close()`d BEFORE IT IS UNMOUNTED, BECAUSE THE FOCUS
   * RESTORE BELONGS TO `close()` AND NOT TO REMOVAL.
   *
   * `showModal()` records the element that was focused when it ran and hands
   * focus back to it on `close()`. Tearing a still-open modal out of the
   * document skips that step outright: the dialog leaves the top layer, the
   * focused node goes with it, and focus lands on `<body>`. Consumers that
   * mount conditionally — `{pending !== null && <Dialog open …/>}`, which is
   * most of them — hit that on EVERY dismissal route at once, because escape,
   * the close button, a form's own cancel and a backdrop click all do the one
   * thing: flip the condition. Measured on the orders board before this hook:
   * `document.activeElement === document.body` after all four, with the card
   * that opened the dialog still on screen and 107 tab presses away.
   *
   * `useLayoutEffect` AND NOT `useEffect`, WHICH IS THE ENTIRE FIX. React runs
   * layout cleanups while the node is still in the document, and defers passive
   * ones until after it has detached it — so this same `close()` written into
   * the effect below would run against an orphan and restore nothing. The
   * cleanup is the only body this hook has; there is nothing to do on the way
   * in, and `open` is deliberately not a dependency, because "the element is
   * going away" is the one moment this is about.
   *
   * IT DOES NOT PLAY THE EXIT ANIMATION, deliberately. The element is about to
   * stop existing, so a 200ms fade is a race against React's own removal, and
   * the thing lost when the race is lost is an operator's place on the board.
   * The animated path below is for a dialog that STAYS MOUNTED and closes.
   *
   * THE OPENER IS ALSO REMEMBERED HERE, AND THAT IS NOT DISTRUST OF THE UA — it
   * is the one case the UA cannot get right. `showModal()` anchors on whatever
   * was focused at the instant it ran, and React's `autoFocus` (which
   * `ConfirmDialog` sets on its confirm button) runs EARLIER, during commit. In
   * a browser that is harmless, because `.dialog:not([open])` is
   * `display: none`, so the focus call finds nothing focusable and the anchor is
   * still the invoking control. But that makes a focus guarantee depend on a
   * stylesheet — and where the rule does not apply, measured directly, the
   * anchor becomes the confirm button, which then leaves with the dialog and
   * strands focus on `<body>` again. So: remembered during RENDER, before React
   * has touched the DOM at all, and used only when the restore visibly failed.
   *
   * WRITING A REF DURING RENDER IS THE INITIALISATION CASE AND NOTHING WIDER.
   * It happens once per open, it reads a value that lives outside React, and it
   * is idempotent — a render run twice, which is what StrictMode does and what a
   * discarded concurrent render amounts to, observes the same
   * `document.activeElement` and captures the same node. There is no earlier
   * hook to do it in: every effect, layout ones included, runs after React has
   * already had its chance to move focus.
   */
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement;
  wasOpen.current = open;

  useLayoutEffect(
    () => () => {
      const el = ref.current;
      if (el === null || !el.open) return;
      el.close();
      /*
       * The UA leads and this only catches it falling. "Fell" means focus is on
       * nothing, or on a node INSIDE the dialog that is about to be removed with
       * it — never "focus is somewhere else", because somewhere else is a place
       * the operator may have chosen, and yanking them out of it would be the
       * same rudeness this whole hook exists to undo.
       */
      const landed = document.activeElement;
      const lost = landed === null || landed === document.body || el.contains(landed);
      const back = opener.current;
      if (lost && back instanceof HTMLElement && back.isConnected && !el.contains(back)) {
        back.focus();
      }
    },
    [],
  );

  // Closing waits for the exit animation, so dialogs don't blink out of
  // existence after a 340ms entrance.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      el.classList.remove('dialog--leaving');
      if (!el.open) el.showModal();
      return;
    }
    if (!el.open) return;
    el.classList.add('dialog--leaving');
    const done = () => {
      el.classList.remove('dialog--leaving');
      if (el.open) el.close();
    };
    const t = window.setTimeout(done, 200);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={sheet ? 'dialog dialog--sheet' : 'dialog'}
      aria-labelledby={named ? titleId : undefined}
      style={{ ['--dialog-w' as string]: width }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Backdrop click: the dialog element itself fills the viewport.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog__panel">
        {named && (
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
        )}
        {description && <p className="dialog__desc">{description}</p>}
        {children && <div className="dialog__body">{children}</div>}
        <div className="dialog__footer">
          {footer ?? (
            <button className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Replaces window.confirm — same job, inside the design system. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  /**
   * WHAT THE WAY OUT IS CALLED, for the callers where "Cancel" is the wrong
   * word rather than merely a dull one.
   *
   * The default is right almost everywhere and actively dangerous in one shape:
   * a destructive action whose own label opens with the same verb. The orders
   * board's `confirmLabel` is "Cancel this order", and a screen reader's button
   * list then reads "Cancel" directly above "Cancel this order" — two
   * money-adjacent buttons that do opposite things, told apart only by two
   * words a listener has not heard yet, on the one dialog in the app that ends
   * an order and releases its stock.
   *
   * IT IS THE CALLER'S WORD AND NOT A RULE HERE, because the useful label names
   * what saying no PRESERVES ("Keep this order"), and only the caller knows
   * what that is. A generic rewrite in this file — "No", "Dismiss" — would be
   * distinct from `confirmLabel` and still say nothing.
   */
  dismissLabel = 'Cancel',
  danger = false,
  sheet = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  dismissLabel?: string;
  danger?: boolean;
  /** Forwarded to `Dialog` — a confirmation is the commonest one-handed dialog. */
  sheet?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      sheet={sheet}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            {dismissLabel}
          </button>
          <button
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            autoFocus
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
