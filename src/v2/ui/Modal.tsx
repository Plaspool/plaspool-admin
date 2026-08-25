import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './primitives';

/**
 * A dialog, and the scrim is a real click target: clicking the backdrop closes,
 * which is the gesture people reach for before they look for the ✕.
 *
 * FOCUS IS MOVED INTO THE PANEL ON OPEN and returned to whatever had it when
 * the modal closes. Without the return, dismissing a dialog drops focus onto
 * `<body>` and the next Tab starts from the top of the page — which, on a
 * screen whose primary action opened the dialog, means tabbing back through
 * the whole sidebar.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  flush = false,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Removes body padding, for a modal whose content is a full-bleed list. */
  flush?: boolean;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);

    /* The page behind must not scroll under the scrim. Restoring the previous
       value rather than clearing it, because two stacked modals would otherwise
       have the inner one unlock the page as it closed. */
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      restoreTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="modal__scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={wide ? { maxWidth: '44rem' } : undefined}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <Button tone="plain" iconOnly aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className={flush ? 'modal__body modal__body--flush' : 'modal__body'}>{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
