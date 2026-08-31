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
        subtitle="How the blog post editor works for you. Saved for this device as soon as you change it."
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
            The advanced editor is the full writing studio: shortcut commands, autosave that keeps
            earlier drafts, and find and replace. The quick editor is always one tap away, and this
            choice applies to this device only.
          </span>
        </div>
      </Card>
    </div>
  );
}
