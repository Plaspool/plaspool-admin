import * as RP from '@radix-ui/react-progress';
import './ui.css';

/**
 * Loading vocabulary, used consistently:
 *
 *   Skeleton  — we know the SHAPE of what's coming (a list, an article).
 *   Spinner   — an action the user triggered is in flight, shape unknown.
 *   Progress  — we know how far along we are (import, export, upload).
 *
 * Everything here is delayed by default: a loader that flashes for 80ms is
 * noise, and reads as jank rather than as feedback.
 */

export function Spinner({
  size = 16,
  label = 'Loading',
}: {
  size?: number;
  label?: string;
}) {
  return (
    <span
      className="ui-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
    />
  );
}

export function Skeleton({
  width,
  height,
  radius,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: string;
  className?: string;
}) {
  return (
    <span
      className={`ui-skeleton ${className ?? ''}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <RP.Root className="ui-progress" value={clamped} aria-label={label}>
      <RP.Indicator
        className="ui-progress__bar"
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </RP.Root>
  );
}

/** Indeterminate bar for work whose duration we can't predict. */
export function ProgressIndeterminate({ label }: { label: string }) {
  return (
    <div className="ui-progress" role="status" aria-label={label}>
      <div className="ui-progress__bar ui-progress__bar--indeterminate" />
    </div>
  );
}
