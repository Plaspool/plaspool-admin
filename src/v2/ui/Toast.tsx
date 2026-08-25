import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

/**
 * The bottom-centre notice, matching the reference admin.
 *
 * It REPORTS and never asks. "Analytics bar hidden" is the canonical case: the
 * action already happened, the toast is the receipt, and nothing is lost if it
 * is missed. Anything that needs an answer is a `Modal`.
 *
 * v2 has its own rather than importing `src/components/Toast` for the same
 * reason as everything else here — that provider carries v1's `toast.css`.
 */

interface ToastRecord {
  id: number;
  message: string;
  tone: 'default' | 'critical';
}

interface ToastApi {
  /** Auto-dismisses after `ms`. Returns nothing: a toast is fire-and-forget. */
  show: (message: string, tone?: 'default' | 'critical') => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: 'default' | 'critical' = 'default') => {
      const id = nextId.current++;
      setItems((list) => {
        /* Two at once is the ceiling. A stack of six covers the control that
           produced them, and the sixth is the only one anybody reads anyway. */
        const next = [...list, { id, message, tone }];
        return next.slice(-2);
      });
      window.setTimeout(() => dismiss(id), tone === 'critical' ? 6000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toaster" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={t.tone === 'critical' ? 'toast toast--critical' : 'toast'}>
            <span>{t.message}</span>
            <button
              type="button"
              className="toast__close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
