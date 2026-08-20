import * as RSw from '@radix-ui/react-switch';
import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import './ui.css';

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /**
   * Draws AND announces the refusal — Radix sets `disabled` and
   * `data-disabled`, so a screen reader says "dimmed" rather than offering a
   * switch that will not move. Pair it with a `Tooltip` giving the reason: a
   * dimmed control with no explanation is the same dead end as one that fails
   * on click, arrived at more quietly.
   */
  disabled?: boolean;
}) {
  return (
    <RSw.Root
      className="ui-switch"
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
    >
      <RSw.Thumb className="ui-switch__thumb" />
    </RSw.Root>
  );
}

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RT.Provider delayDuration={400} skipDelayDuration={300}>
    {children}
  </RT.Provider>
);

export function Tooltip({
  children,
  label,
  kbd,
  side = 'bottom',
}: {
  children: ReactNode;
  label: string;
  kbd?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="ui-tooltip" side={side} sideOffset={8}>
          {label}
          {kbd && <span className="ui-tooltip__kbd">{kbd}</span>}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
