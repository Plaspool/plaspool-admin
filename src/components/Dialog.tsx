import { useEffect, useRef, type ReactNode } from 'react';
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
        <h2 className="dialog__title">{title}</h2>
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
  danger = false,
  sheet = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
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
            Cancel
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
