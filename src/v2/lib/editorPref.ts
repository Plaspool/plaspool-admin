/**
 * Which post editor opens by default — the v2 lite editor, or the advanced
 * editor (the v1 writing environment, ported wholesale under
 * `src/v2/advanced/`).
 *
 * A DEVICE preference, deliberately: it lives in localStorage rather than on
 * the server because it describes this browser's writing setup (screen size,
 * habit), not the store — the same reasoning as the analytics-bar toggle,
 * but persistent, because "which editor do I write in" is not a per-session
 * whim. Every read is wrapped: Safari's private mode throws on storage
 * access, and a preference must never take the editor down with it.
 */

const KEY = 'plaspool.v2.advanced-editor-default';
const ASKED = 'plaspool.v2.advanced-editor-asked';

export function advancedByDefault(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdvancedByDefault(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0');
    window.localStorage.setItem(ASKED, '1');
  } catch {
    /* not remembering is survivable */
  }
}

/** Whether the first-open "make this your default?" question has been put —
 *  asked once, ever; Settings is the place to change your mind after that. */
export function advancedDefaultAsked(): boolean {
  try {
    return window.localStorage.getItem(ASKED) === '1';
  } catch {
    return true; /* storage broken → never nag */
  }
}

export function markAdvancedDefaultAsked(): void {
  try {
    window.localStorage.setItem(ASKED, '1');
  } catch {
    /* see above */
  }
}
