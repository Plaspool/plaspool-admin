import type { ReactNode } from 'react';

/**
 * The card section every detail screen composes: a title row with one optional
 * action on the right, then the body. It formalises what the design gallery
 * had been doing ad hoc — the class names live in one place now, which is the
 * whole reason it is a component.
 */
export function Card({
  title,
  action,
  flush = false,
  children,
}: {
  title?: string;
  /** One control, right-aligned on the title row — "Add version", "View all". */
  action?: ReactNode;
  /** Removes body padding, for a card whose content is a full-bleed table. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {title ? (
        <div className="card__head">
          <h2 className="card__title">{title}</h2>
          {action}
        </div>
      ) : null}
      {flush ? children : <div className="card__body stack">{children}</div>}
    </section>
  );
}
