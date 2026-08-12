import { useEffect, useState } from 'react';

/**
 * App settings.
 *
 * localStorage, not IndexedDB — this is exactly the "tiny configuration"
 * case: a handful of scalars that must be readable synchronously before the
 * first paint (theme) and that are worthless without the device they were set
 * on. Nothing a writer authored ever lives here.
 *
 * TODO(backend): settings become a per-user document. Last-write-wins on
 * `updatedAt` is sufficient — these are preferences, not content, so a
 * conflict costs the user a re-toggle rather than a paragraph. See
 * ARCHITECTURE.md § Settings sync.
 */

/**
 * Re-exported, not redefined. A post can pin a layout (`Post.template`), so the
 * union lives in `shared/types.ts` where both sides of the app can see it; this
 * keeps every existing `from '../data/settings'` import working.
 */
export type { ReadingTemplate } from '../../shared/types';
import type { ReadingTemplate } from '../../shared/types';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface Settings {
  /** Layout used by the reading view and the preview. */
  template: ReadingTemplate;
  theme: ThemeSetting;
  /** Show the reading-progress bar at the top of an article. */
  readingProgress: boolean;
  /** Show estimated reading time in bylines and cards. */
  showReadingTime: boolean;
  /** Author name printed on articles. */
  authorName: string;
  /**
   * The sidebar is held open instead of peeking on hover.
   *
   * It lives here rather than in its own key because this object is already
   * the app's per-device preference document and already survives a reload
   * before first paint — and the rail's width decides how much room the route
   * underneath gets, so a value read one frame late is a visible jump.
   */
  sidebarPinned: boolean;
  updatedAt: number;
}

export const TEMPLATES: {
  id: ReadingTemplate;
  name: string;
  description: string;
}[] = [
  {
    id: 'magazine',
    name: 'Magazine',
    description: 'Large serif headline, cover image breaking past the text column.',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'No hero. Small title, generous space, nothing between you and the words.',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Full-bleed cover above the title, drop cap, centred masthead.',
  },
  {
    id: 'technical',
    name: 'Technical',
    description: 'Sans-serif body, wider measure, metadata in a side rail. Built for code.',
  },
];

export const DEFAULT_SETTINGS: Settings = {
  template: 'magazine',
  theme: 'system',
  readingProgress: true,
  showReadingTime: true,
  authorName: 'You',
  /*
   * Collapsed is the default, and it is a claim about what this app is for:
   * the widest thing on screen should be the writing, not the navigation. A
   * writer who wants the rail open says so once and it stays said.
   */
  sidebarPinned: false,
  updatedAt: 0,
};

const KEY = 'blog-admin:settings';

export function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge over defaults so a settings file written by an older build — or a
    // hand-edited one — can never leave the app with an undefined template.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      template: TEMPLATES.some((t) => t.id === parsed.template)
        ? (parsed.template as ReadingTemplate)
        : DEFAULT_SETTINGS.template,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(next: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...next, updatedAt: Date.now() }));
  } catch {
    // A full or disabled localStorage must not break the app; the user just
    // loses preference persistence for this session.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const EVENT = 'blog-admin:settings-changed';

/** Settings shared across every component, kept in sync within the tab. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => readSettings());

  useEffect(() => {
    const sync = () => setSettings(readSettings());
    window.addEventListener(EVENT, sync);
    // `storage` fires for OTHER tabs, so preferences follow you across them.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...readSettings(), ...patch, updatedAt: Date.now() };
    writeSettings(next);
    setSettings(next);
  };

  return [settings, update];
}
