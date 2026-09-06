import { useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Float } from './Float';

/**
 * The (i) that carries the long form of a short cell — the owner's ask for
 * the add-ons list, after a full sentence per row pushed the Status column
 * off the screen: "shorten the text, add the (i) icon that shows the full
 * stuff when you hover".
 *
 * Hover or keyboard focus opens it; leaving or blurring closes it; a tap
 * opens it on a screen with no hover, and the next tap anywhere else closes
 * it (the Float's outside-pointerdown). The panel is a Float — portaled, so a
 * table's scroll clip never cuts it — and it stops its own clicks, so a
 * clickable row underneath does not navigate when the reader taps the text.
 * The trigger is a real button, which the row's click handler already treats
 * as that control's click rather than the row's.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="itip"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
      >
        <Info aria-hidden="true" />
      </button>
      {/* Right-aligned: an (i) sits at the END of a cell or a line, so the
          panel grows leftwards into the room that exists rather than into the
          sliver between the icon and the viewport's edge, where a left-aligned
          panel wrapped one word per line. Escape closes without refocusing:
          focus never left the trigger (hover does not move it, and a keyboard
          user is already on it), and refocusing would fire onFocus and reopen
          the panel it just shut. */}
      <Float open={open} anchor={trigger} align="right" className="itip__panel" role="tooltip" onClose={() => setOpen(false)}>
        <div id={id}>{children}</div>
      </Float>
    </>
  );
}
