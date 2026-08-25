/**
 * v2 port: optional ready-made mount for the advanced editor.
 *
 * The copied editor needs three things around it that v1's main.tsx used to
 * provide and v2's does not:
 *
 *   1. the `.advx` scope element — every stylesheet in this module is scoped
 *      under it (skin.css, prose.css, editor.css, the component css);
 *   2. `TooltipProvider` — Radix Tooltip's Root THROWS without a provider, and
 *      `FeatureToggle` renders one whenever the toggle is disabled with a
 *      reason (v1 mounted the provider app-wide in main.tsx);
 *   3. `ToastProvider` — without it `useToast` is a silent no-op, and every
 *      save/publish/trash confirmation in the editor speaks through it. It is
 *      mounted INSIDE `.advx` so the toast stack picks up the v1 skin.
 *
 * The editor is mounted behind `PostGate mode="edit"`, exactly as v1's router
 * does — the gate decides what may render for an id (local-only, pending
 * resolution, someone else's post, offline, forbidden) BEFORE the frozen
 * editor sees a row, and skipping it would let the editor mount on states it
 * assumes cannot reach it.
 *
 * Register it as a route element, e.g. `{ path: '/content/posts/:id/advanced',
 * element: <AdvancedEditor /> }` — both the gate and the editor read the post
 * id from the `id` param. If the shell prefers its own wrapper, replicate this
 * structure there instead; nothing in this file is load-bearing beyond it.
 */
import { TooltipProvider } from './components/ui/Switch';
import { ToastProvider } from './components/Toast';
import { PostGate } from './components/PostGate';
import EditorRoute from './routes/Editor';

export default function AdvancedEditor() {
  return (
    <div className="advx">
      <TooltipProvider>
        <ToastProvider>
          <PostGate mode="edit">
            <EditorRoute />
          </PostGate>
        </ToastProvider>
      </TooltipProvider>
    </div>
  );
}
