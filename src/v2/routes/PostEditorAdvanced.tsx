import { useState } from 'react';
import AdvancedEditor from '../advanced/AdvancedEditor';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/primitives';
import {
  advancedDefaultAsked,
  markAdvancedDefaultAsked,
  setAdvancedByDefault,
} from '../lib/editorPref';

/**
 * `/content/posts/:id/advanced` — the v1 writing studio, back by the owner's
 * request: slash menu, autosave with revisions, find and replace, the block
 * grip. The studio itself is a verbatim port under `src/v2/advanced/`
 * (`AdvancedEditor` composes its skin scope, providers and PostGate); this
 * route only adds the ONE v2 thing around it — the first-open question.
 *
 * THE QUESTION IS ASKED ONCE, EVER. A dialog that reappears until answered
 * is a nag; "Not now" is an answer and is remembered exactly like "yes"
 * (`editorPref.ts`). After that, Settings → Writing is where the choice
 * lives. The dialog mounts OUTSIDE the studio's `.advx` scope on purpose:
 * inside it, v1's tokens would reskin a v2 modal into neither system.
 */
export default function PostEditorAdvanced() {
  const [ask, setAsk] = useState(() => !advancedDefaultAsked());

  const dismiss = () => {
    markAdvancedDefaultAsked();
    setAsk(false);
  };

  return (
    <>
      <AdvancedEditor />
      {ask ? (
        <Modal
          title="Make this your default editor?"
          onClose={dismiss}
          footer={
            <>
              <Button onClick={dismiss}>Not now</Button>
              <Button
                tone="primary"
                onClick={() => {
                  setAdvancedByDefault(true);
                  setAsk(false);
                }}
              >
                Make it default
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
            You are in the advanced editor — the full writing studio, with slash commands,
            autosave with revisions, and find and replace. Make it the default and every post on
            this device opens here; the quick editor stays available, and Settings → Writing can
            change this any time.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
