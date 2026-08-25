import type { ReactNode } from 'react';

export interface TimelineEvent {
  id: string;
  message: ReactNode;
  /** The line under the message: when, and who, already formatted. */
  meta?: ReactNode;
  /** Colours the dot. Neutral is a hollow ring; the tones fill it. */
  tone?: 'neutral' | 'ok' | 'critical' | 'info';
}

/**
 * Dots on a rail, newest first — the order timeline and the audit trail. The
 * rail is drawn by every item except the last, so it ends AT the final event
 * rather than trailing past it: same construction as the sidebar connector,
 * for the same reason.
 */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="tl">
      {events.map((event) => (
        <li key={event.id} className="tl__item">
          <span
            className={
              event.tone && event.tone !== 'neutral' ? `tl__dot tl__dot--${event.tone}` : 'tl__dot'
            }
            aria-hidden="true"
          />
          <div className="tl__content">
            <div className="tl__msg">{event.message}</div>
            {event.meta ? <div className="tl__meta">{event.meta}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
