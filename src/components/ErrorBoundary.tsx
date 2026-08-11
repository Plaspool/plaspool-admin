import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render crash must never look like data loss. Posts stay in IndexedDB
 * regardless, so the recovery copy says so explicitly and offers a reload
 * rather than leaving a white screen.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Studio crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="empty" style={{ minHeight: '100dvh', alignContent: 'center' }}>
        <h1 className="empty__title">Something went wrong on screen</h1>
        <p className="empty__body">
          Your writing is safe — every post is stored in this browser and nothing
          was lost. Reloading usually clears this.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
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
        <pre
          style={{
            marginTop: '1.5rem',
            maxWidth: '40rem',
            overflow: 'auto',
            fontSize: 'var(--step--2)',
            color: 'var(--ink-4)',
            fontFamily: 'var(--font-mono)',
            textAlign: 'left',
          }}
        >
          {error.message}
        </pre>
      </div>
    );
  }
}
