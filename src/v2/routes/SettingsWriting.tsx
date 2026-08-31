import { useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { PageHeader } from '../ui/Page';
import { Card } from '../ui/Card';
import { Toggle } from '../ui/Field';
import { advancedByDefault, setAdvancedByDefault } from '../lib/editorPref';
import { useToast } from '../ui/Toast';

/**
 * WRITING — `/settings/writing`: which post editor a post opens in.
 *
 * A DEVICE preference (see `editorPref.ts`), so no CAS, no server round trip —
 * the toggle is the whole transaction, which is why this page carries no load
 * state, no error banner and no save button.
 */
export default function SettingsWriting() {
  const toast = useToast();
  const [advancedDefault, setAdvancedDefault] = useState(() => advancedByDefault());

  return (
    <div className="page">
      <PageHeader
        icon={<SettingsIcon />}
        title="Writing"
        backTo="/settings"
        backLabel="Settings"
        subtitle="Editor preferences for blog posts — per device, saved as you flip them."
      />

      <Card title="Editor">
        <div className="stack stack--tight">
          <Toggle
            label="Open posts in the advanced editor"
            checked={advancedDefault}
            onChange={(next) => {
              setAdvancedDefault(next);
              setAdvancedByDefault(next);
              toast.show(
                next
                  ? 'Posts open in the advanced editor on this device'
                  : 'Posts open in the quick editor on this device',
              );
            }}
          />
          <span className="field__hint">
            The advanced editor is the full writing studio — slash commands, autosave with
            revisions, find and replace. The quick editor stays one tap away either way, and this
            choice is per device.
          </span>
        </div>
      </Card>
    </div>
  );
}
