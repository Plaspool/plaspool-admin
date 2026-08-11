import { useEffect } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { readSettings, useSettings, type ThemeSetting } from '../data/settings';
import { Tooltip } from './ui/Switch';

/**
 * Theme lives in the same settings store as everything else, so the toggle in
 * the masthead and the control in Settings can never disagree.
 */
export function applyTheme(theme: ThemeSetting) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Read + apply before first paint, so there is no flash of the wrong theme. */
export function initTheme() {
  applyTheme(readSettings().theme);
}

const NEXT: Record<ThemeSetting, ThemeSetting> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const LABEL: Record<ThemeSetting, string> = {
  system: 'Theme: matching your system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle() {
  const [settings, update] = useSettings();
  const theme = settings.theme;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS while set to 'system', without a reload.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <Tooltip label={LABEL[theme]}>
      <button
        className="btn btn--ghost btn--sm"
        onClick={() => update({ theme: NEXT[theme] })}
        aria-label={LABEL[theme]}
      >
        <Icon className="ui-ic" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
