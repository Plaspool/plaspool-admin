import { useEffect, useState } from 'react';
import type { SaveState } from './useAutosave';

/** Subtle by design: present, never shouting. Only errors get colour. */
export function SaveIndicator({ state }: { state: SaveState }) {
  const [, tick] = useState(0);

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
      text = 'Not saved — retrying';
      tone = ' save--error';
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
