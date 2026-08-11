import { useRouteError } from 'react-router-dom';

/**
 * A screen that crashed must never imply the writing is gone. Posts live in
 * IndexedDB and are untouched by a render failure, so say so first and offer
 * the two things that actually help: reload, or go back to the list.
 */
export function RouteError() {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  return (
    <div className="empty" style={{ minHeight: '100dvh', alignContent: 'center' }}>
      <h1 className="empty__title">This screen ran into a problem</h1>
      <p className="empty__body">
        Your posts are safe — they’re stored in this browser and nothing was lost.
      </p>
      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button
          className="btn btn--outline"
          onClick={() => {
            window.location.hash = '#/';
            window.location.reload();
          }}
        >
          Back to posts
        </button>
      </div>
      {message && (
        <pre
          style={{
            marginTop: 'var(--s5)',
            maxWidth: '40rem',
            overflow: 'auto',
            fontSize: 'var(--step--2)',
            color: 'var(--ink-4)',
            fontFamily: 'var(--font-mono)',
            textAlign: 'left',
          }}
        >
          {message}
        </pre>
      )}
    </div>
  );
}
