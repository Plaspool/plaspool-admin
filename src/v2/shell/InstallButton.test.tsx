import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The install offer, pinned on the two ways it goes wrong quietly.
 *
 *  - **An inert control is worse than no control.** The button has to be
 *    ABSENT — not disabled, not a panel saying "your browser cannot" — when the
 *    app is already installed or when this browser will never offer a prompt.
 *    Nobody photographs a greyed button; they just stop trusting the bar.
 *  - **iOS is a different offer, not a missing one.** No browser on an iPhone
 *    implements `beforeinstallprompt`, so the same "no prompt" fact that means
 *    "offer nothing" on a desktop means "show the Share steps" there. Getting
 *    that backwards hides the feature from the devices it is most for.
 *
 * THE STORE IS MODULE STATE and it outlives a test, because the listener that
 * catches the browser's prompt has to be registered on import — long before
 * any component mounts. So the environment is driven the way the browser
 * drives it, through real events on `window` and a scriptable `matchMedia`,
 * and `afterEach` spends the held prompt with `appinstalled` rather than
 * reaching inside the module.
 */

import { InstallButton } from './InstallButton';

/* What jsdom does not implement and `userEvent` touches on every click. */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const CHROME_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_ON_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const realUserAgent = navigator.userAgent;

/** Whether `(display-mode: standalone)` currently matches — i.e. whether this
 *  window was launched from a home screen rather than opened in a browser. */
let standalone = false;

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

/**
 * The browser offering an install, as `install.ts` receives it: a real event
 * on `window`, carrying the two members Chrome puts on it. Returns the
 * `prompt` spy, which is the thing the button is supposed to reach.
 */
function offerInstall() {
  const prompt = vi.fn(async () => undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return prompt;
}

beforeEach(() => {
  standalone = false;
  setUserAgent(CHROME_ON_WINDOWS);
  window.matchMedia = ((query: string) => ({
    matches: query.includes('display-mode: standalone') ? standalone : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // This component asks the server for nothing and must not start. A stub that
  // throws says so out loud rather than letting a stray request pass silently.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('InstallButton must not make requests');
    }),
  );
});

afterEach(() => {
  cleanup();
  /* Spend whatever prompt a test captured, the way the browser does once the
     app is installed. Without this the next test starts with an offer it did
     not make. */
  act(() => {
    window.dispatchEvent(new Event('appinstalled'));
  });
  setUserAgent(realUserAgent);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const trigger = () => screen.queryByRole('button', { name: 'Install PlaSpool' });

describe('the install offer is absent unless it can do something', () => {
  it('renders nothing on a browser that has offered no prompt', () => {
    const { container } = render(<InstallButton />);
    // Desktop Firefox, or a Chrome that has not decided we are installable.
    // `innerHTML` rather than `toBeEmptyDOMElement`: this repo has no
    // `@testing-library/jest-dom`, and an unknown matcher passes silently.
    expect(container.innerHTML).toBe('');
    expect(trigger()).toBeNull();
  });

  it('renders nothing when the app is already installed', () => {
    standalone = true;
    render(<InstallButton />);
    expect(trigger()).toBeNull();
  });

  it('stays absent in the installed window even while a prompt is held', () => {
    /* A browser tab and the installed window can both be open, and the event
       is a window-level fact. The installed one must not offer to install
       itself — installed wins over a held prompt, deliberately. */
    standalone = true;
    offerInstall();
    render(<InstallButton />);
    expect(trigger()).toBeNull();
  });
});

describe('the install offer, once the browser has made one', () => {
  it('appears when the prompt arrives after the bar is already on screen', async () => {
    render(<InstallButton />);
    expect(trigger()).toBeNull();
    // The real sequence: Chrome fires this a beat after load, usually while
    // the Gate is still waiting on /auth/me.
    offerInstall();
    expect(await screen.findByRole('button', { name: 'Install PlaSpool' })).toBeTruthy();
  });

  it('explains what installing does before asking for it', async () => {
    offerInstall();
    render(<InstallButton />);
    await userEvent.click(trigger()!);
    expect(screen.getByRole('dialog', { name: 'Install PlaSpool' }).textContent).toContain(
      'opens like an app',
    );
  });

  it('asks the browser to install when Install is pressed', async () => {
    const prompt = offerInstall();
    render(<InstallButton />);
    await userEvent.click(trigger()!);
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    // The browser's own dialog is what installs; all this button can do is
    // raise it, so reaching `prompt()` IS the behaviour.
    await waitFor(() => expect(prompt).toHaveBeenCalled());
  });
});

describe('on iOS, where there is no prompt to raise', () => {
  it('offers the Share-menu steps instead of a button', async () => {
    setUserAgent(SAFARI_ON_IPHONE);
    render(<InstallButton />);
    await userEvent.click(trigger()!);

    const panel = screen.getByRole('dialog', { name: 'Install PlaSpool' });
    expect(panel.textContent).toContain('Share');
    expect(panel.textContent).toContain('Add to Home Screen');
    /* An "Install" button here would be a lie: Safari exposes nothing a page
       can call, so the steps are the whole offer. */
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('says nothing once it is on the home screen', () => {
    setUserAgent(SAFARI_ON_IPHONE);
    /* iOS matches no display-mode query; it answers `navigator.standalone`
       instead, and reading only the media query would keep offering the steps
       to somebody already looking at the installed app. */
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    try {
      render(<InstallButton />);
      expect(trigger()).toBeNull();
    } finally {
      Object.defineProperty(window.navigator, 'standalone', {
        value: undefined,
        configurable: true,
      });
    }
  });
});
