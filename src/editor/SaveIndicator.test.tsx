import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SaveIndicator } from './SaveIndicator';

/**
 * The one sentence the writing surface can say about connectivity.
 *
 * `Editor.tsx` is frozen, so this component is the only thing in the editor
 * that can distinguish "the save failed" from "there is no network". The
 * distinction is not cosmetic: a failed save offline has already written a
 * `pending` row and the overlay the frozen editor hydrates from, so the words
 * are on disk — and "Not saved" is the sentence that makes people stop typing.
 */

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

function goOffline(): void {
  setOnline(false);
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('SaveIndicator', () => {
  it('says "retrying" for a failed save while the connection is up', () => {
    render(<SaveIndicator state={{ kind: 'error', message: 'boom', attempt: 1 }} />);
    expect(screen.getByText('Not saved — retrying')).toBeTruthy();
  });

  it('says the words are on this device once the connection goes', () => {
    const { container } = render(<SaveIndicator state={{ kind: 'error', message: 'boom', attempt: 1 }} />);
    goOffline();

    expect(screen.getByText('Offline — kept on this device')).toBeTruthy();
    expect(screen.queryByText('Not saved — retrying')).toBeNull();
    // The error colour is reserved for the states a human has to end.
    expect(container.querySelector('.save--error')).toBeNull();
  });

  it('still shouts about a conflict offline, because that one needs a person', () => {
    const { container } = render(
      <SaveIndicator state={{ kind: 'conflict' }} />,
    );
    goOffline();

    expect(screen.getByText('Paused — needs your decision')).toBeTruthy();
    expect(container.querySelector('.save--error')).toBeTruthy();
  });

  it('still shouts about a deleted post offline', () => {
    const { container } = render(<SaveIndicator state={{ kind: 'gone' }} />);
    goOffline();

    expect(screen.getByText('Not saved — post was deleted')).toBeTruthy();
    expect(container.querySelector('.save--error')).toBeTruthy();
  });
});
