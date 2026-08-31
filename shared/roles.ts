/**
 * ROLES AND WHAT THEY MAY TOUCH — one table, shared by both sides (2026-08-31).
 *
 * The server's permission middleware and the team screen's role picker read
 * THIS file, so what a role is described as doing and what it is allowed to do
 * cannot drift apart — the failure mode of every hand-maintained permissions
 * page. `server/middleware/permissions.ts` maps URL surfaces onto the
 * `Domain`s below; this file says which roles hold which domains and what the
 * words on the screen are.
 *
 * THE OWNER IS SINGULAR BY CONSTRUCTION, not by count. `role = 'owner'` is
 * never mintable through the API: invites refuse it, role changes refuse it in
 * BOTH directions (nobody is promoted to owner, the owner is never demoted),
 * and `countActiveOwners` keeps the last one enableable. So the instance
 * always has exactly the owner it was seeded with, and "there can only be one
 * owner" is a property, not a rule someone remembers.
 *
 * DEVELOPERS ARE OWNER-GRADE EVERYWHERE EXCEPT ABOUT EACH OTHER. A developer
 * holds every domain the owner holds; what they cannot do is remove or demote
 * the owner or a fellow developer, or mint one. The owner can remove anyone
 * but themselves. `canManage` below is that sentence as code.
 */

export type Role =
  | 'owner'
  | 'developer'
  | 'writer'
  | 'supply_chain'
  | 'support'
  | 'marketing';

/**
 * The surfaces permissions are granted over. Deliberately coarse: a domain is
 * a whole area of the admin, not a verb — fine-grained read/write splits are
 * exactly the matrices nobody keeps correct.
 */
export type Domain =
  | 'content' // blog posts, categories, images, featured, banners
  | 'products' // catalog, variants, prices, inventory, reviews moderation
  | 'orders' // order list/detail, fulfilment, the email outbox
  | 'customers' // buyer list
  | 'payments' // payment intents, refunds
  | 'marketing' // discounts, rewards, returns, broadcasts, subscribers
  | 'analytics' // stats, revenue, audit
  | 'settings' // shipping zones, delivery areas
  | 'team' // users and invites
  | 'danger'; // backup, destroy, sweep — owner/developer territory

export interface RoleInfo {
  role: Role;
  label: string;
  /** One line for pickers and table cells. */
  tagline: string;
  /** The sentence the team screen shows under the role — what it ENTAILS. */
  description: string;
  grants: 'all' | readonly Domain[];
}

export const ROLE_INFO: Record<Role, RoleInfo> = {
  owner: {
    role: 'owner',
    label: 'Owner',
    tagline: 'Everything, including the endings',
    description:
      'Full access to every surface, plus the destructive ones — backup, destroy, refunds. ' +
      'Exactly one per store. Can remove anyone except themselves.',
    grants: 'all',
  },
  developer: {
    role: 'developer',
    label: 'Developer',
    tagline: 'Owner-grade access, several allowed',
    description:
      'The same access as the owner across every surface. Cannot remove or demote the owner ' +
      'or another developer, and cannot create developers — the owner does that.',
    grants: 'all',
  },
  writer: {
    role: 'writer',
    label: 'Content writer',
    tagline: 'Products and the blog',
    description:
      'Create, edit, publish and delete products and blog content — descriptions, SEO, ' +
      'images, categories, reviews. Nothing money-adjacent: no orders, payments or settings.',
    grants: ['content', 'products'],
  },
  supply_chain: {
    role: 'supply_chain',
    label: 'Supply chain',
    tagline: 'Stock in, parcels out',
    description:
      'Inventory and fulfilment — adjust stock, create parcels, mark shipped and delivered, ' +
      'watch the numbers. No refunds, no payments, no customer marketing.',
    grants: ['products', 'orders', 'analytics'],
  },
  support: {
    role: 'support',
    label: 'Support',
    tagline: 'Orders and the people behind them',
    description:
      'Read and resolve orders — fulfilment states, timelines, the email outbox — and look ' +
      'up customers. Refunds stay with the owner and developers.',
    grants: ['orders', 'customers', 'analytics'],
  },
  marketing: {
    role: 'marketing',
    label: 'Marketing',
    tagline: 'Campaigns, codes and broadcasts',
    description:
      'Discounts, banners, rewards programs, returns, email broadcasts and subscribers, ' +
      'plus analytics. No orders, catalog or settings.',
    grants: ['marketing', 'customers', 'analytics'],
  },
};

/** Every role, in the order pickers should list them. */
export const ALL_ROLES = [
  'owner',
  'developer',
  'writer',
  'supply_chain',
  'support',
  'marketing',
] as const satisfies readonly Role[];

/** What an invite or a role change may name — never `owner` (see header).
 * A `const` TUPLE so `z.enum(ASSIGNABLE_ROLES)` keeps the literal types. */
export const ASSIGNABLE_ROLES = [
  'developer',
  'writer',
  'supply_chain',
  'support',
  'marketing',
] as const satisfies readonly Exclude<Role, 'owner'>[];

export function isRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: Role): string {
  return ROLE_INFO[role]?.label ?? role;
}

/** The full-access pair — the tier `requireAdmin()` and every inline
 * owner-grade check reads, so "owner or developer" is written once. */
export function isAdminRole(role: Role): boolean {
  return role === 'owner' || role === 'developer';
}

export function hasDomain(role: Role, domain: Domain): boolean {
  const grants = ROLE_INFO[role]?.grants;
  if (grants === 'all') return true;
  return Array.isArray(grants) ? grants.includes(domain) : false;
}

/**
 * May `actor` manage (disable, enable, re-role) an account currently holding
 * `target`? The seniority sentence from the header, in one place:
 *
 * - the owner manages everyone (the self and last-owner refusals are the
 *   route's, because they are about identity and counts, not roles);
 * - a developer manages everyone EXCEPT the owner and other developers;
 * - nobody else manages anybody.
 */
export function canManage(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'developer') return target !== 'owner' && target !== 'developer';
  return false;
}

/**
 * May `actor` hand out `next` — on an invite, or on a role change? The same
 * seniority applied to the role being GRANTED: the owner grants anything
 * assignable; a developer grants anything below developer.
 */
export function canAssign(actor: Role, next: Role): boolean {
  if (next === 'owner') return false;
  if (actor === 'owner') return true;
  if (actor === 'developer') return next !== 'developer';
  return false;
}
