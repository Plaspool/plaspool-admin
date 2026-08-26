import { useEffect, useRef, type HTMLAttributes } from 'react';

/**
 * The `.tscroll` horizontal scroller, with its truth written onto it as data
 * attributes so the stylesheet can EARN the pinned column's paint instead of
 * wearing it:
 *
 *   `data-x-overflow` — the table is genuinely wider than the card. Only now
 *     may a pinned cell paint an opaque background; on a table that fits, the
 *     pin is an ordinary column and any strip or seam would be a lie.
 *   `data-x-clip` — columns are still hidden UNDER the pin (the scroll has
 *     not reached its right end). Only now does the pin cast its shadow, and
 *     it fades the moment the last column comes flush — a shadow with
 *     nothing underneath it is a claim of depth the layout isn't making.
 *
 * Written straight onto the DOM node rather than through state: scroll fires
 * per frame, and re-rendering a whole table to move one attribute is the kind
 * of jank the attribute exists to prevent. A ResizeObserver on the scroller
 * AND its content catches the other ways truth changes — a window resize, a
 * column toggled off, rows arriving.
 */
export function TableScroll(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const write = () => {
      const overflow = el.scrollWidth - el.clientWidth > 1;
      const clip = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      if (overflow) el.setAttribute('data-x-overflow', '');
      else el.removeAttribute('data-x-overflow');
      if (clip) el.setAttribute('data-x-clip', '');
      else el.removeAttribute('data-x-clip');
    };

    write();
    el.addEventListener('scroll', write, { passive: true });
    const ro = new ResizeObserver(write);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', write);
      ro.disconnect();
    };
  }, []);

  return <div ref={ref} {...props} />;
}
