import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
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
 *     grow-corner (`transform-origin`) flips with it; slides back inside a
 *     side edge that would cut it (`max-width` stays the panel's own job —
 *     this only moves it);
 *   · reports the anchor's width as `--float-anchor-w`, so a panel that
 *     wants to match its trigger (a select) states that in its own CSS
 *     instead of relying on `min-width: 100%`, which a fixed element would
 *     resolve against the viewport;
 *   · closes on outside pointerdown, on Escape (capture phase, stopping
 *     there — so inside a modal, Escape peels the panel and NOT the modal),
 *     on a resize that changes the viewport WIDTH (a height-only change is
 *     an on-screen keyboard, and re-places the panel rather than dismissing
 *     the input it contains), and on any scroll outside the panel itself — a
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

  /* One measurement off the anchor. Extracted from the open-time effect
     because a viewport that changes HEIGHT under an on-screen keyboard has
     to re-run it — see `onResize` below, where closing on that was the bug. */
  const place = useCallback(() => {
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
  }, [align, anchor]);

  /* Measure on open, before paint — the panel must never flash unplaced. */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  /* If the panel would run off the bottom, sit it above the trigger instead;
     if it would run off a side, slide it back until it fits — measured after
     the panel exists (its size is its content's), still before paint, once
     per open. The side clamp is what the alerts popover lacked when its
     title landed at x = -28 on a 375px phone (CLAUDE.md §5): a left-hung
     panel wider than the room to its right, or a right-hung one wider than
     the room to its left, would otherwise run off exactly the same way. */
  const adjusted = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      adjusted.current = false;
      return;
    }
    if (adjusted.current || pos === null || !panel.current || !anchor.current) return;
    adjusted.current = true;
    const panelRect = panel.current.getBoundingClientRect();
    const anchorRect = anchor.current.getBoundingClientRect();
    const floor = window.innerHeight - 8;
    const edge = window.innerWidth - 8;
    setPos((was) => {
      if (!was) return was;
      let next = was;
      if (panelRect.bottom > floor) {
        const above = Math.max(8, anchorRect.top - 8 - panelRect.height);
        next = { ...next, top: above, origin: next.origin.replace('top', 'bottom') };
      }
      if (next.left !== undefined && panelRect.right > edge) {
        next = { ...next, left: Math.max(8, next.left - (panelRect.right - edge)) };
      }
      if (next.right !== undefined && panelRect.left < 8) {
        next = { ...next, right: Math.max(8, next.right - (8 - panelRect.left)) };
      }
      /* Unchanged is the same object, so React skips the re-render. */
      return next;
    });
  }, [open, pos, anchor]);

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
    /* THE ON-SCREEN KEYBOARD IS A RESIZE, AND CLOSING ON IT MADE THIS PANEL
       UNUSABLE ON A PHONE. Tapping the search box inside a SearchSelect
       focuses an input; the keyboard opens; Android/Chrome shrinks the
       layout viewport; this fired; the panel that owned the input dismissed
       itself before a character could be typed — reported as "it opens and
       closes immediately, my keyboard opens".

       A real resize moves the WIDTH: a window drag, a rotation. A keyboard
       only ever changes the height. So width decides, and a height-only
       change RE-PLACES the panel against its anchor instead — which is also
       the honest answer, the anchor having moved with the layout. */
    const widthAtOpen = window.innerWidth;
    function onResize() {
      if (window.innerWidth !== widthAtOpen) {
        closeRef.current();
        return;
      }
      /* Re-run the flip and the side clamp against the new viewport, not
         just the base measurement. */
      adjusted.current = false;
      place();
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
  }, [open, anchor, place]);

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
