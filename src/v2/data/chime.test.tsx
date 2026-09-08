// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The chime — the half of "loud" the web actually permits.
 *
 * THE NOTIFICATIONS API HAS NO SOUND PARAMETER, in any browser, so a push
 * cannot carry a tone. What people mean by "loud like WhatsApp Web" is an open
 * tab playing audio, which is what this is. These tests pin the two properties
 * that decide whether it is heard or is a bug: it must not throw on a browser
 * that refuses audio, and it must NOT schedule notes against a context that has
 * not been unlocked — those would fire whenever the context later woke, which
 * is a chime for an order somebody dealt with an hour ago.
 */

interface FakeNode {
  connect: (to: unknown) => unknown
  start?: (at: number) => void
  stop?: (at: number) => void
}

/* A REAL function, never an arrow: `new` on an arrow throws, the production
   code catches that and answers null, and the test then watches nothing happen
   and calls it a failure to play. */
function fakeContext(state: string) {
  const started: number[] = []
  const frequencies: number[] = []
  const resume = vi.fn(async () => undefined)
  const ctx = {
    state,
    currentTime: 0,
    resume,
    destination: {},
    createOscillator: (): FakeNode & { type: string; frequency: { value: number } } => {
      const node = {
        type: 'sine',
        frequency: {
          set value(v: number) {
            frequencies.push(v)
          },
          get value() {
            return 0
          },
        },
        connect: (to: unknown) => to,
        start: (at: number) => started.push(at),
        stop: () => {},
      }
      return node as never
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: (to: unknown) => to,
    }),
  }
  return { ctx, started, frequencies, resume }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the order chime', () => {
  it('plays two notes once the context is running', async () => {
    const { ctx, started, frequencies } = fakeContext('running');
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return ctx;
      }),
    );
    const { playChime } = await import('./chime');

    playChime();

    // Two notes, the second after the first — a rising pair, not a single beep.
    expect(started).toHaveLength(2);
    expect(started[1]).toBeGreaterThan(started[0]);
    expect(frequencies).toEqual([659.25, 880]);
  });

  it('SCHEDULES NOTHING while the context is suspended, and asks it to wake', async () => {
    /*
     * THE BUG THIS PREVENTS. Notes scheduled against a suspended context are
     * not dropped — they fire whenever it is later resumed, which is a chime
     * for an order that was dealt with an hour ago. Silence now and a correct
     * ring on the next order is the only sane behaviour.
     */
    const { ctx, started, resume } = fakeContext('suspended');
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return ctx;
      }),
    );
    const { playChime } = await import('./chime');

    playChime();

    expect(started).toHaveLength(0);
    expect(resume).toHaveBeenCalled();
  });

  it('is silent, not broken, on a browser with no Web Audio at all', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { playChime, unlockChime } = await import('./chime');

    expect(() => playChime()).not.toThrow();
    expect(() => unlockChime()).not.toThrow();
  });

  it('reuses one context rather than leaking one per order', async () => {
    /* Browsers cap how many AudioContexts a page may hold, and the cap is low
       enough to reach on a tab left open all day. */
    const { ctx } = fakeContext('running');
    const Ctor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal('AudioContext', Ctor);
    const { playChime } = await import('./chime');

    playChime();
    playChime();
    playChime();

    expect(Ctor).toHaveBeenCalledTimes(1);
  });
});
