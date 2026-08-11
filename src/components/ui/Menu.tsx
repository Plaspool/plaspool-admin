import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import './ui.css';

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({
  children,
  align = 'end',
  side = 'bottom',
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <DM.Portal>
      <DM.Content className="ui-menu" align={align} side={side} sideOffset={6}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  icon,
  shortcut,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <DM.Item
      className={`ui-menu__item${danger ? ' ui-menu__item--danger' : ''}`}
      onSelect={onSelect}
      disabled={disabled}
    >
      {icon && <span className="ui-menu__icon">{icon}</span>}
      <span className="ui-menu__label">{children}</span>
      {shortcut && <span className="ui-menu__shortcut">{shortcut}</span>}
    </DM.Item>
  );
}

export const MenuSeparator = () => <DM.Separator className="ui-menu__sep" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <DM.Label className="ui-menu__grouplabel">{children}</DM.Label>
);
