import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, Check, CheckCheck, Inbox } from 'lucide-react';
import { fetchAlerts, isUnread, markAllRead, markRead, type OpsAlert } from '../data/alerts';

/**
 * The bell and its Alerts popover.
 *
 * The bell rings on hover (CSS), holds its pressed disc while the panel is up
 * (same rule as every menu trigger), and carries the one bright-blue dot in
 * the system while anything is unread. Content is fetched on mount and again
 * when the panel opens or the window refocuses — throttled, because each
 * fetch is two real queries and the tab may sit open all day.
 */
const STALE_MS = 60_000;

/** "Sunday at 4:05 PM" inside the week, "21 Aug at 4:05 PM" beyond it. */
function whenLabel(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const withinWeek = Date.now() - ms < 7 * 86_400_000;
  if (withinWeek) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

export function AlertsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OpsAlert[] | null>(null);
  const [failed, setFailed] = useState(false);
  /* Read/unread lives in localStorage; this nonce is how marking one read
     re-renders without refetching. */
  const [, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastFetch = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return;
    if (!force && Date.now() - lastFetch.current < STALE_MS) return;
    inFlight.current = true;
    try {
      const next = await fetchAlerts();
      lastFetch.current = Date.now();
      setItems(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    function onDown(event: PointerEvent) {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refresh]);

  const unreadCount = (items ?? []).filter(isUnread).length;

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={'top__icon top__bell' + (open ? ' is-open' : '')}
        aria-label={unreadCount ? `Alerts, ${unreadCount} unread` : 'Alerts'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {unreadCount > 0 ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
        {unreadCount > 0 ? <span className="top__bell__dot" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className="alerts" role="dialog" aria-label="Alerts">
          <div className="alerts__head">
            <span className="alerts__title">Alerts</span>
            <span className="alerts__tools">
              {items && items.length > 0 ? (
                <button
                  type="button"
                  className="alerts__tool"
                  title="Mark all as read"
                  aria-label="Mark all as read"
                  onClick={() => {
                    markAllRead(items);
                    bump();
                  }}
                >
                  <CheckCheck aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </div>

          {failed && !items ? (
            <div className="alerts__empty">
              <span className="empty__mark" aria-hidden="true">
                <Inbox />
              </span>
              <span className="alerts__itemtitle">Couldn’t load alerts</span>
              <span className="alerts__body">Check your connection, then try again.</span>
              <button type="button" className="btn btn--default" onClick={() => void refresh(true)}>
                Retry
              </button>
            </div>
          ) : items === null ? (
            <div className="alerts__list" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="alerts__item" style={{ cursor: 'default' }}>
                  <span className="alerts__dot" style={{ background: 'transparent' }} />
                  <span className="alerts__content">
                    <span className="skel" style={{ width: '7rem' }} />
                    <span className="skel" style={{ width: '13rem' }} />
                    <span className="skel" style={{ width: '10rem', opacity: 0.6 }} />
                  </span>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="alerts__empty">
              <span className="empty__mark" aria-hidden="true">
                <Inbox />
              </span>
              <span className="alerts__itemtitle">You’re all caught up</span>
              <span className="alerts__body">
                Stuck emails, waiting reviews and low stock will show up here.
              </span>
            </div>
          ) : (
            <div className="alerts__list">
              {items.map((alert) => {
                const unread = isUnread(alert);
                return (
                  <div
                    key={alert.id}
                    className={unread ? 'alerts__item is-unread' : 'alerts__item'}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      markRead(alert);
                      setOpen(false);
                      navigate(alert.to);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        markRead(alert);
                        setOpen(false);
                        navigate(alert.to);
                      }
                    }}
                  >
                    <span className="alerts__dot" aria-hidden="true" />
                    <span className="alerts__content">
                      <span className="alerts__meta">
                        {alert.source} • {whenLabel(alert.at)}
                      </span>
                      <span className="alerts__itemtitle">{alert.title}</span>
                      <span className="alerts__body">{alert.body}</span>
                    </span>
                    {unread ? (
                      <button
                        type="button"
                        className="alerts__check"
                        title="Mark as read"
                        aria-label={`Mark “${alert.title}” as read`}
                        onClick={(e) => {
                          e.stopPropagation();
                          markRead(alert);
                          bump();
                        }}
                      >
                        <Check aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {items && items.length > 0 ? <div className="alerts__foot">No more alerts</div> : null}
        </div>
      ) : null}
    </div>
  );
}
