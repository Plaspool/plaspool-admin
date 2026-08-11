/**
 * The shortcut list, as data.
 *
 * This file is the single source of truth for what the cheatsheet advertises,
 * and every editor binding in it was read out of the installed extension rather
 * than remembered. That matters: Round 1's critic found the Link button
 * promising `Ctrl+K` in its tooltip when no such handler existed anywhere, and a
 * cheatsheet is that same failure mode with twenty more places to hide. The
 * editor-owned rows are pinned by `__tests__/shortcuts.test.tsx`, which presses
 * each one through the real keymap and asserts the document changed.
 */

export interface Shortcut {
  /** Key names; `Mod` renders as ⌘ on Apple hardware and Ctrl everywhere else. */
  keys: string;
  label: string;
  /** When the shortcut only applies in a particular state. */
  note?: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/**
 * Apple keyboards use ⌘ where everyone else uses Ctrl, and a cheatsheet that
 * gets this wrong is worse than none — it teaches the wrong chord.
 */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function renderKeys(keys: string, apple = isApple()): string[] {
  return keys.split('+').map((k) => {
    if (k === 'Mod') return apple ? '⌘' : 'Ctrl';
    if (k === 'Alt') return apple ? '⌥' : 'Alt';
    if (k === 'Shift') return apple ? '⇧' : 'Shift';
    if (k === 'Enter') return apple ? '⏎' : 'Enter';
    return k;
  });
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: '?', label: 'Show this list', note: 'when not typing' },
      { keys: 'Mod+/', label: 'Show this list', note: 'even while typing' },
      { keys: 'Esc', label: 'Close a dialog, menu or the find bar' },
    ],
  },
  {
    title: 'Writing',
    items: [
      { keys: 'Mod+S', label: 'Save now', note: 'and mark a checkpoint you can return to' },
      { keys: 'Mod+F', label: 'Find and replace', note: 'this document, not the page' },
      { keys: 'Mod+Z', label: 'Undo' },
      { keys: 'Mod+Shift+Z', label: 'Redo' },
      { keys: 'Mod+K', label: 'Link', note: 'with text selected' },
    ],
  },
  {
    title: 'Blocks',
    items: [
      { keys: '/', label: 'Open the block palette', note: 'on an empty line' },
      { keys: 'Alt+↑', label: 'Move this block up' },
      { keys: 'Alt+↓', label: 'Move this block down' },
      { keys: 'Mod+Alt+2', label: 'Heading' },
      { keys: 'Mod+Alt+3', label: 'Subheading' },
      { keys: 'Mod+Shift+B', label: 'Quote' },
      { keys: 'Mod+Shift+8', label: 'Bulleted list' },
      { keys: 'Mod+Shift+7', label: 'Numbered list' },
      { keys: 'Mod+Shift+9', label: 'Checklist' },
      { keys: 'Mod+Alt+C', label: 'Code block' },
      { keys: 'Tab', label: 'Indent a list item' },
      { keys: 'Shift+Tab', label: 'Outdent a list item' },
    ],
  },
  {
    title: 'Formatting',
    items: [
      { keys: 'Mod+B', label: 'Bold' },
      { keys: 'Mod+I', label: 'Italic' },
      { keys: 'Mod+U', label: 'Underline' },
      { keys: 'Mod+Shift+S', label: 'Strikethrough' },
      { keys: 'Mod+E', label: 'Inline code' },
      { keys: 'Shift+Enter', label: 'Line break inside a paragraph' },
    ],
  },
];
