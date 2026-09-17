import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  CreditCard,
  Gift,
  MapPin,
  MapPinned,
  PenLine,
  Send,
  Settings as SettingsIcon,
  Truck,
  Users,
} from 'lucide-react';
import { PageHeader } from '../ui/Page';
import { Card } from '../ui/Card';

/**
 * SETTINGS — `/settings`, now an INDEX rather than a screen that does work.
 *
 * The one-page cut carried zones AND the writing preference on a single
 * route; the team surface would have made it three unrelated jobs behind one
 * title. So this page holds nothing but the doors — the reference admin's
 * own settings anatomy — and each area is its own subroute with a breadcrumb
 * back here. The zones surface moved whole to `/settings/shipping`
 * (`SettingsShipping.tsx`), byte-for-byte behaviour.
 *
 * DELIVERY AREAS ARE LISTED BUT NOT MOVED: `/orders/delivery` already exists
 * under Orders, where the people pricing districts actually work. The card
 * here is a second door to the same room, not a second room.
 */

interface SettingsDoor {
  to: string;
  icon: ReactNode;
  title: string;
  body: string;
}

const DOORS: SettingsDoor[] = [
  {
    to: '/settings/payments',
    icon: <CreditCard />,
    title: 'Payments',
    body: 'Which gateway takes a payment, and which currencies each one can charge.',
  },
  {
    to: '/settings/shipping',
    icon: <Truck />,
    title: 'Shipping',
    body: 'What each part of the country pays for delivery, and how much tax is added.',
  },
  {
    to: '/settings/delivery-courier',
    /* NOT the truck: Shipping is the door above it and wears one, and two
       identical icons side by side make the pair unreadable at a glance. */
    icon: <Send />,
    title: 'Delivery courier',
    body: 'Who carries parcels to customers — by hand, Fez Delivery or Terminal Africa.',
  },
  {
    to: '/settings/mystery-box',
    icon: <Gift />,
    title: 'Mystery box',
    body: 'Switch the mystery box on or off, choose what can go inside, and how boxes get filled.',
  },
  {
    to: '/settings/notifications',
    icon: <Bell />,
    title: 'Notifications',
    body: 'Who gets an email when an order comes in.',
  },
  {
    to: '/settings/team',
    icon: <Users />,
    title: 'Team',
    body: 'Who can sign in, and what each of them is allowed to do.',
  },
  {
    to: '/settings/writing',
    icon: <PenLine />,
    title: 'Writing',
    body: 'How the blog post editor works for you.',
  },
  {
    to: '/orders/delivery',
    icon: <MapPinned />,
    title: 'Delivery areas',
    body: 'Charge a different delivery price for particular districts.',
  },
  /* The same arrangement as Delivery areas: the screen lives under Spools,
     where the people who switch a state on actually work, and this is a
     second door to it. */
  {
    to: '/spools/areas',
    icon: <MapPin />,
    title: 'Where we collect',
    body: 'Which districts you collect returned items from.',
  },
];

export default function Settings() {
  return (
    <div className="page">
      <PageHeader
        icon={<SettingsIcon />}
        title="Settings"
        subtitle="The store's configuration, gathered behind one door each."
      />

      <Card flush>
        {DOORS.map((door) => (
          <Link key={door.to} to={door.to} className="pick">
            <span className="pick__icon" aria-hidden="true">
              {door.icon}
            </span>
            <span>
              <span className="pick__title">{door.title}</span>
              <span className="pick__body" style={{ display: 'block' }}>
                {door.body}
              </span>
            </span>
            <span className="pick__chev" aria-hidden="true" style={{ display: 'flex' }}>
              <ChevronRight />
            </span>
          </Link>
        ))}
      </Card>
    </div>
  );
}
