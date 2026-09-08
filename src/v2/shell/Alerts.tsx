import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, Check, CheckCheck, Inbox } from 'lucide-react';
import {
  fetchAlerts,
  isOrderAlert,
  isUnread,
  markAllRead,
  markRead,
  type OpsAlert,
} from '../data/alerts';
import {
  notifyPermission,
  requestNotifyPermission,
  showAlertNotification,
  type NotifyPermission,
} from '../data/notify';
import { Button } from '../ui/primitives';

/**
 * The bell and its Alerts popover.
 *
 * The bell rings on hover (CSS), holds its pressed disc while the panel is up
 * (same rule as every menu trigger), and carries the one bright-blue dot in
 * the system while anything is unread. Content is fetched on mount, on a poll,
 * when the panel opens and when the window refocuses — throttled everywhere
 * but the poll, because each fetch is two real queries and the tab may sit
 * open all day.
 */
const STALE_MS = 60_000;

/**
 * THE ADMIN'S ONE TIMER, AND IT LIVES HERE RATHER THAN ON EVERY SCREEN.
 *
 * A new order has to arrive without anybody touching the keyboard — that is
 * the whole feature — and until now nothing refetched unless a person did
 * something. But a timer per screen is the arrangement `Shell.tsx` argues
 * against at length: six screens each polling their own list is six queries a
 * minute on a tab somebody left open over a weekend, and every one of them
 * fires against a tab nobody is looking at. So exactly one interval exists,
 * it belongs to the bell, and it stops dead while the tab is hidden.
 *
 * FORTY-FIVE SECONDS, because the thing being waited for is a person walking
 * to a machine: a minute late is unnoticeable and ten seconds early is worth
 * nothing, while the cost is one aggregate query per tick against a serverless
 * database that bills for being awake. It is deliberately NOT the same number
 * as `STALE_MS` — the poll IS the cadence, so it forces past that throttle,
 * and the throttle stays what it is for the focus and open-panel paths.
 */
const POLL_MS = 45_000;

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
  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission);

  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastFetch = useRef(0);
  const inFlight = useRef(false);
  /**
   * The order alerts this bell has already seen, and `null` until the first
   * list has landed.
   *
   * THAT NULL IS THE WHOLE REASON THIS IS NOT A PLAIN SET. The first refresh
   * SEEDS this and rings for nothing: without it every admin opening the app
   * in the morning would be handed five notifications for five orders they
   * dealt with yesterday, which teaches them within a day to switch the
   * permission off — and the permission, once denied, is not something this
   * app can ever ask for again.
   */
  const seenOrders = useRef<Set<string> | null>(null);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return;
    if (!force && Date.now() - lastFetch.current < STALE_MS) return;
    inFlight.current = true;
    try {
      const next = await fetchAlerts();
      lastFetch.current = Date.now();
      setItems(next);
      setFailed(false);

      /* Only orders that were not in the PREVIOUS list ring. Swapping the ref
         before raising anything means a notification that somehow throws (it
         cannot — `showAlertNotification` swallows everything) still cannot
         make the same order ring twice on the next tick. */
      const orders = next.filter(isOrderAlert);
      const seen = seenOrders.current;
      seenOrders.current = new Set(orders.map((alert) => alert.id));
      if (seen !== null) {
        for (const order of orders) {
          if (!seen.has(order.id)) void showAlertNotification(order);
        }
      }
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

  /* The poll (see POLL_MS). A HIDDEN TAB COSTS NOTHING: the tick returns
     without asking, and coming back to the tab asks straight away — through
     the ordinary throttle, so flicking between two tabs does not turn into a
     query per flick, while a tab that has been in the background for the
     minute that actually matters refetches on the spot.

     `visibilitychange` rather than `focus`, and beside it rather than instead
     of it: a background tab in a focused window fires neither, and a window
     brought forward without the tab changing fires only `focus`. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refresh(true);
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
                New orders, failed emails, reviews waiting to be checked, and low stock show up
                here.
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

          {/* THE OFFER, ONCE, AND ONLY WHILE IT IS STILL AN OFFER. Asking for
              the notification permission on load is how a browser learns to
              deny it permanently, so the ask lives behind a click and the
              click is this line. It disappears the moment the answer is
              either yes or no — there is nothing left to offer, and a row
              that keeps asking after a refusal is the pattern the browsers
              built the permanent denial for. It takes the foot's slot rather
              than adding a second strip: "No more alerts" is a full stop, and
              this is worth more than a full stop. */}
          {permission === 'default' ? (
            <div className="alerts__foot">
              <Button
                tone="plain"
                onClick={() => {
                  /* Called straight out of the click: every browser refuses a
                     permission request that is not inside a user gesture. */
                  void requestNotifyPermission().then(setPermission);
                }}
              >
                Get a notification when an order comes in
              </Button>
            </div>
          ) : items && items.length > 0 ? (
            <div className="alerts__foot">No more alerts</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
