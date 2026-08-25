import { useEffect, useState } from 'react';
import { useOnline } from '../components/OfflineBanner';
import type { SaveState } from './useAutosave';

/**
 * Subtle by design: present, never shouting. Only errors get colour.
 *
 * THE OFFLINE ARM IS HERE BECAUSE THE EDITOR IS FROZEN. `Editor.tsx` renders
 * this component and cannot be changed, so this is the only place the writing
 * surface can say anything about connectivity — and it has to, because after
 * the cutover a dropped link makes every save fail and the only word on screen
 * would be "Not saved".
 *
 * That word is wrong twice over while offline. It is wrong about the outcome:
 * `savePost` writes a `pending` row and the overlay the frozen editor hydrates
 * from before it rethrows, so the paragraph survives the failure and the
 * reload. And it is wrong about the cause: nothing is broken, there is no
 * network. A writer who reads "Not saved" stops writing, which is the one
 * behaviour this app's whole durability story exists to make unnecessary.
 */
export function SaveIndicator({ state }: { state: SaveState }) {
  const [, tick] = useState(0);
  const online = useOnline();

  // Re-render every 20s so "Saved 2 minutes ago" stays honest. The interval is
  // set up in an effect (never during render) so opening a dialog mid-save
  // can't schedule a state update while another component is rendering.
  useEffect(() => {
    if (state.kind !== 'saved') return;
    const t = window.setInterval(() => tick((n) => n + 1), 20_000);
    return () => window.clearInterval(t);
  }, [state.kind]);

  let text = '';
  let tone = '';
  switch (state.kind) {
    case 'idle':
      text = '';
      break;
    case 'dirty':
      text = 'Unsaved changes';
      break;
    case 'saving':
      text = 'Saving…';
      break;
    case 'saved':
      text = `Saved ${relative(state.at)}`;
      break;
    case 'error':
      /*
       * `save--error` is deliberately dropped offline. The colour is reserved
       * for "something needs your attention", and a missing connection does
       * not — the words are already durable and the retry is automatic. The
       * two states that DO need a human keep it below.
       */
      text = online ? 'Not saved — retrying' : 'Offline — kept on this device';
      tone = online ? ' save--error' : '';
      break;
    // These two used to render nothing, which meant the indicator was silent
    // in exactly the states where silence is most dangerous.
    case 'conflict':
      text = 'Paused — needs your decision';
      tone = ' save--error';
      break;
    case 'gone':
      text = 'Not saved — post was deleted';
      tone = ' save--error';
      break;
  }

  return (
    <span className={`save${tone}`} aria-live="polite">
      {state.kind === 'saving' && <span className="save__dot" aria-hidden="true" />}
      {text}
    </span>
  );
}

function relative(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
