import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import './ui.css';

// v2 port: portal into the .advx scope wrapper instead of <body>. In v1 this
// css was global so a body-level portal was styled; here both the tokens and
// the scoped ui.css live under .advx, so the popup must render inside it.
const advxContainer = () =>
  (typeof document === 'undefined'
    ? undefined
    : document.querySelector<HTMLElement>('.advx')) ?? undefined;

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
  placeholder,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  /**
   * Shown while `value` is `''`. Radix treats an empty string as "nothing
   * selected" and renders the `placeholder` INSTEAD of the option's own label
   * — so an `{ value: '', label: 'Choose…' }` option's label never appears on
   * the trigger and the control sits visibly blank without this.
   */
  placeholder?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <RS.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RS.Trigger className={`ui-select ui-select--${size}`} aria-label={label}>
        <RS.Value placeholder={placeholder}>{current?.label}</RS.Value>
        <RS.Icon asChild>
          <ChevronDown className="ui-ic" aria-hidden="true" />
        </RS.Icon>
      </RS.Trigger>
      {/* v2 port: container keeps the popup inside the .advx scope. */}
      <RS.Portal container={advxContainer()}>
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
