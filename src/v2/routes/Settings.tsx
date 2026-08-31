import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MapPinned, PenLine, Settings as SettingsIcon, Truck, Users } from 'lucide-react';
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
    to: '/settings/shipping',
    icon: <Truck />,
    title: 'Shipping',
    body: 'Zones, rates and tax — what a region pays to receive a parcel.',
  },
  {
    to: '/settings/team',
    icon: <Users />,
    title: 'Team',
    body: 'Who can sign in, and what each role may touch.',
  },
  {
    to: '/settings/writing',
    icon: <PenLine />,
    title: 'Writing',
    body: 'Editor preferences for blog posts.',
  },
  {
    to: '/orders/delivery',
    icon: <MapPinned />,
    title: 'Delivery areas',
    body: 'District-by-district overrides on what the zones charge.',
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
