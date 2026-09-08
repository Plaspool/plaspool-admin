import { useRef, useState, useSyncExternalStore } from 'react';
import { Download, Share, SquarePlus } from 'lucide-react';
import { Float } from '../ui/Float';
import { Button } from '../ui/primitives';
import { brand } from '../../brand';
import { getInstallState, promptInstall, subscribe } from './install';

/**
 * "Install PlaSpool" — the topbar offer, and nothing at all when there is
 * nothing to offer.
 *
 * IT RENDERS NULL RATHER THAN DISABLING ITSELF. An install prompt only exists
 * on some browsers, and only until it is used; a permanently greyed control on
 * every other machine is a question the reader cannot answer and cannot
 * dismiss. So: no prompt and not iOS, or already installed, and the button is
 * not in the bar. `install.ts` decides which of those it is.
 *
 * NOT the v2 `<Button>` primitive for the trigger. `.btn` is a light bevelled
 * control, and this bar is the one dark surface in the system — it would read
 * as a white pill dropped next to the bell. `top__icon` is the shape every
 * other control up here already has, and it gets the pressed disc for free
 * from `.top__icon:active, .top__icon.is-open`.
 *
 * The panel itself is a `<Float>` like every other popover in v2, so it cannot
 * be clipped by the bar it hangs from, and it is deliberately WORDY for a
 * popover: most people have never installed a web app, and "Install" alone
 * sounds like it downloads something.
 */
export function InstallButton() {
  const { status } = useSyncExternalStore(subscribe, getInstallState);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const title = `Install ${brand.name}`;

  if (status === 'installed' || status === 'unavailable') return null;

  async function install() {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      /* The panel closes whichever way they answered. Accepting takes the
         whole button away (the prompt is spent), and dismissing means they
         have said no to the thing this panel is asking. */
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="menu">
      <button
        ref={trigger}
        type="button"
        className={open ? 'top__icon is-open' : 'top__icon'}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Download aria-hidden="true" />
      </button>

      <Float
        open={open}
        anchor={trigger}
        align="right"
        className="install"
        role="dialog"
        ariaLabel={title}
        onClose={(opts) => {
          setOpen(false);
          if (opts?.refocus) trigger.current?.focus();
        }}
      >
        <div className="install__title">{title}</div>
        <p className="install__body">
          Add it to your home screen and it opens like an app — full screen, one tap, and the
          screens you have already opened still work when the signal drops.
        </p>

        {status === 'ready' ? (
          <Button tone="primary" busy={busy} onClick={() => void install()}>
            Install
          </Button>
        ) : (
          /* iOS. Safari has no install prompt to raise, on any browser on the
             device, so the steps ARE the offer — with the two icons drawn, as
             they are the part people scan for rather than read. */
          <ol className="install__steps">
            <li>
              Tap <Share aria-hidden="true" /> Share, in your browser&rsquo;s toolbar.
            </li>
            <li>
              Choose <SquarePlus aria-hidden="true" /> Add to Home Screen.
            </li>
            <li>Tap Add, and it is on your home screen.</li>
          </ol>
        )}
      </Float>
    </div>
  );
}
