import type { ReactNode } from 'react';
import {
  BarChart3,
  FileText,
  House,
  Mail,
  Megaphone,
  Package,
  Settings,
  ShoppingBag,
  TicketPercent,
  Users,
} from 'lucide-react';

/**
 * The rail, and it is a flat list of sections rather than a tree of everything.
 *
 * v1's sidebar grew to cover every route the app has, which is how a rail ends
 * up with four entries nobody has clicked this year sitting above the one they
 * open forty times a day. v2 lists what an operator actually works through in a
 * shift and puts the rest behind Settings.
 *
 * `soon: true` MARKS A ROUTE v2 HAS NOT REDESIGNED YET. It still navigates —
 * to a real v2 screen that says what is missing — because a nav item that does
 * nothing when clicked is indistinguishable from a broken one. No v1 screen is
 * mounted anywhere in this build.
 */

export interface NavChild {
  to: string;
  label: string;
  soon?: boolean;
}

export interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  soon?: boolean;
  /** Shown only while the section is current, the way the reference admin does
   *  it: sub-navigation that is always expanded is a rail with thirty items. */
  children?: NavChild[];
}

export const NAV: NavEntry[] = [
  { to: '/home', label: 'Home', icon: <House /> },
  {
    to: '/orders',
    label: 'Orders',
    icon: <ShoppingBag />,
    children: [
      { to: '/orders/returns', label: 'Returns' },
      { to: '/orders/delivery', label: 'Delivery areas' },
    ],
  },
  {
    to: '/products',
    label: 'Products',
    icon: <Package />,
    children: [
      { to: '/products/categories', label: 'Categories' },
      { to: '/products/inventory', label: 'Inventory' },
      { to: '/products/reviews', label: 'Reviews' },
    ],
  },
  { to: '/customers', label: 'Customers', icon: <Users /> },
  { to: '/discounts', label: 'Discounts', icon: <TicketPercent /> },
  {
    to: '/content',
    label: 'Content',
    icon: <FileText />,
    children: [
      { to: '/content/posts', label: 'Blog posts' },
      { to: '/content/featured', label: 'Featured' },
      { to: '/content/banners', label: 'Banners' },
    ],
  },
  { to: '/marketing', label: 'Marketing', icon: <Megaphone /> },
  {
    to: '/emails',
    label: 'Emails',
    icon: <Mail />,
    children: [
      { to: '/emails/broadcasts', label: 'Broadcasts' },
      { to: '/emails/templates', label: 'Templates' },
      { to: '/emails/subscribers', label: 'Subscribers' },
    ],
  },
  { to: '/analytics', label: 'Analytics', icon: <BarChart3 />, soon: true },
];

export const NAV_FOOT: NavEntry[] = [
  { to: '/settings', label: 'Settings', icon: <Settings /> },
];
