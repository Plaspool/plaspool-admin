import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import './toast.css';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'danger';
  action?: { label: string; run: () => void };
  /** Set while the toast plays its exit animation, before it is removed. */
  leaving?: boolean;
}

/** Must match the .toast--leaving animation duration in toast.css. */
const EXIT_MS = 180;

interface ToastApi {
  notify: (
    message: string,
    opts?: { tone?: Toast['tone']; action?: Toast['action']; ttl?: number },
  ) => void;
}

const Ctx = createContext<ToastApi>({ notify: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  // Two-phase: mark leaving so the exit animation runs, then unmount.
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      EXIT_MS,
    );
  }, []);

  const notify = useCallback<ToastApi['notify']>(
    (message, opts = {}) => {
      const id = ++seq.current;
      const toast: Toast = { id, message, tone: opts.tone ?? 'info', action: opts.action };
      // Cap the stack so a save-error loop can't paper over the whole screen.
      setToasts((t) => [...t.slice(-2), toast]);
      const ttl = opts.ttl ?? (opts.action ? 8000 : 4000);
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.tone}${t.leaving ? ' toast--leaving' : ''}`}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                className="toast__action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              className="toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
