import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import './ui.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Radix Select styled to our tokens.
 *
 * A native <select> renders its popup with OS chrome, which meant the sort
 * control was the one element in the app the design system couldn't reach —
 * white popup, system blue highlight, in both themes.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  label: string;
  size?: 'sm' | 'md';
}) {
  const current = options.find((o) => o.value === value);
  return (
    <RS.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RS.Trigger className={`ui-select ui-select--${size}`} aria-label={label}>
        <RS.Value>{current?.label}</RS.Value>
        <RS.Icon asChild>
          <ChevronDown className="ui-ic" aria-hidden="true" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className="ui-menu" position="popper" sideOffset={6}>
          <RS.Viewport>
            {options.map((o) => (
              <RS.Item key={o.value} value={o.value} className="ui-menu__item">
                <RS.ItemIndicator asChild>
                  <Check className="ui-ic ui-menu__check" aria-hidden="true" />
                </RS.ItemIndicator>
                <RS.ItemText>{o.label}</RS.ItemText>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
