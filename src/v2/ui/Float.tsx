import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * THE floating panel. Every popover that used to hang `position: absolute`
 * off its trigger — the row ⋯ menu, the column-arrange panel, the inline
 * cell editors, the status and search selects — was one `overflow` ancestor
 * away from being clipped, and the owner photographed three of them cut off
 * mid-panel (`.tscroll`, `.tcard`, `.modal__body` all clip; a sticky cell
 * even OVERPAINTS, being its own stacking context). This is the one
 * mechanism they all ride now, so the failure class is closed rather than
 * patched panel by panel:
 *
 *   · measured off the anchor on open, `position: fixed`, PORTALED to
 *     <body> — outside every clip and every sticky paint order;
 *   · flips above the anchor when the viewport floor would cut it, and the
 *     grow-corner (`transform-origin`) flips with it;
 *   · reports the anchor's width as `--float-anchor-w`, so a panel that
 *     wants to match its trigger (a select) states that in its own CSS
 *     instead of relying on `min-width: 100%`, which a fixed element would
 *     resolve against the viewport;
 *   · closes on outside pointerdown, on Escape (capture phase, stopping
 *     there — so inside a modal, Escape peels the panel and NOT the modal),
 *     on resize, and on any scroll outside the panel itself — a
 *     viewport-pinned panel must not drift from the anchor that summoned
 *     it, and closing is honest where chasing is jitter;
 *   · clicks inside stop propagating through the REACT tree, because a
 *     portal re-routes DOM bubbling but not component bubbling, and a
 *     panel opened from a clickable table row must not navigate it.
 *
 * The `.vfloat` class carries the shared elevation (fixed, z-90 above the
 * modal at 80, `--shadow-float`, the grow-in). The `className` a caller
 * passes keeps carrying that panel's own skin.
 */
export function Float({
  open,
  anchor,
  onClose,
  align = 'right',
  className,
  role,
  ariaLabel,
  dismissOnEscape = true,
  children,
}: {
  open: boolean;
  /** The trigger the panel hangs from. Also exempt from outside-close, so
   *  the trigger's own click can toggle rather than close-then-reopen. */
  anchor: RefObject<HTMLElement | null>;
  /** Called when the panel dismisses itself. `refocus` marks the dismissals
   *  (Escape) after which focus belongs back on the trigger. */
  onClose: (opts?: { refocus?: boolean }) => void;
  align?: 'left' | 'right';
  className: string;
  role?: string;
  ariaLabel?: string;
  /** A combobox whose input gives Escape its own meaning (clear the draft)
   *  opts out of the float's Escape-to-dismiss. */
  dismissOnEscape?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left?: number;
    right?: number;
    anchorW: number;
    origin: string;
  } | null>(null);

  /* Measure on open, before paint — the panel must never flash unplaced. */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(
      align === 'left'
        ? { top: rect.bottom + 8, left: Math.max(8, rect.left), anchorW: rect.width, origin: 'top left' }
        : {
            top: rect.bottom + 8,
            right: Math.max(8, window.innerWidth - rect.right),
            anchorW: rect.width,
            origin: 'top right',
          },
    );
  }, [open, align, anchor]);

  /* If the panel would run off the bottom, sit it above the trigger instead —
     measured after the panel exists (its height is its content's), still
     before paint, once per open. */
  const adjusted = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      adjusted.current = false;
      return;
    }
    if (adjusted.current || pos === null || !panel.current || !anchor.current) return;
    adjusted.current = true;
    const panelRect = panel.current.getBoundingClientRect();
    if (panelRect.bottom > window.innerHeight - 8) {
      const anchorRect = anchor.current.getBoundingClientRect();
      const above = Math.max(8, anchorRect.top - 8 - panelRect.height);
      setPos((was) =>
        was ? { ...was, top: above, origin: was.origin.replace('top', 'bottom') } : was,
      );
    }
  }, [open, pos]);

  /* The dismissals. `onClose` rides a ref so the listeners subscribe once
     per open rather than churning with every parent render. */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const escRef = useRef(dismissOnEscape);
  escRef.current = dismissOnEscape;
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      const target = event.target as Node;
      if (anchor.current?.contains(target)) return;
      if (panel.current?.contains(target)) return;
      closeRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !escRef.current) return;
      /* Capture phase + stop: the panel is the topmost layer, so Escape is
         its to consume — a modal underneath keeps its own Escape for the
         next press. */
      event.stopPropagation();
      closeRef.current({ refocus: true });
    }
    function onScroll(event: Event) {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      closeRef.current();
    }
    function onResize() {
      closeRef.current();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    /* Capture, because the scrolling element is `.main` or `.tscroll`, not
       the window — bubbling scroll events never reach the document. */
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchor]);

  if (!open || pos === null) return null;

  const style: CSSProperties & Record<'--float-anchor-w', string> = {
    top: pos.top,
    left: pos.left,
    right: pos.right,
    transformOrigin: pos.origin,
    '--float-anchor-w': `${pos.anchorW}px`,
  };

  return createPortal(
    <div
      ref={panel}
      className={`${className} vfloat`}
      style={style}
      role={role}
      aria-label={ariaLabel}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
