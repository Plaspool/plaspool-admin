import type { Db } from '../../db/client';
import { resolveBoxCues, type BoxCue, type BoxHowItWorks, type BoxPage } from '../../../shared/commerce/mystery-box';
import { boxFallback, type BoxFallback } from './fallback';
import { boxesSoldSince, mysteryBoxSettings } from './settings';

/**
 * What the storefront reads about the mystery box (migration 1260), split by
 * how long it may be cached.
 *
 * CONTENT rides the product payload, which the shop caches and Settings purges
 * on save: the size, the item count and "How it works".
 *
 * LIVE FACTS ride GET /variants/:id/availability, which is never cached: the
 * cues, because "Only 22 left" and "Just dropped 2 hours ago" go stale the
 * moment they are cached. The raw sales count never leaves the server; only a
 * cue the owner switched on does.
 */

export interface StorefrontBoxSize {
  variantId: string;
  /** "5kg"; null when the only size has no name. Also the variant's Size option. */
  size: string | null;
  /** Items in every box of this size. */
  itemCount: number | null;
}

export interface StorefrontMysteryBox {
  /**
   * The sizes on sale, in the owner's order. A size's price, photo and weight
   * ride the matching entry in `variants`, as for any product.
   */
  sizes: StorefrontBoxSize[];
  /** The FIRST size's name and count, kept for a storefront built before sizes. */
  size: string | null;
  itemCount: number | null;
  howItWorks: BoxHowItWorks;
}

export interface StorefrontBoxLive {
  /** When the box went on sale; null while it is off. */
  onSaleSince: number | null;
  /** Ready to show, in order. Empty when nothing applies. */
  cues: BoxCue[];
}

/** Read once per request, and only when a box is among the products. */
export async function loadBoxShop(db: Db): Promise<{ fallback: BoxFallback; page: BoxPage }> {
  const [fallback, settings] = await Promise.all([boxFallback(db), mysteryBoxSettings(db)]);
  return { fallback, page: settings.page };
}

export function boxShopContent(
  variants: {
    id: string;
    status: string;
    position: number;
    optionValues: Record<string, string>;
    boxItemCount: number | null;
  }[],
  page: BoxPage,
): StorefrontMysteryBox {
  const sizes = variants
    .filter((v) => v.status === 'active')
    .sort((a, b) => a.position - b.position)
    .map((v) => {
      const size = v.optionValues.Size?.trim();
      return { variantId: v.id, size: size ? size : null, itemCount: v.boxItemCount };
    });
  return {
    sizes,
    size: sizes[0]?.size ?? null,
    itemCount: sizes[0]?.itemCount ?? null,
    howItWorks: page.howItWorks,
  };
}

const DAY = 24 * 60 * 60 * 1000;

export async function boxLive(db: Db, variantId: string, available: number | null): Promise<StorefrontBoxLive> {
  const now = Date.now();
  const [settings, sold] = await Promise.all([mysteryBoxSettings(db), boxesSoldSince(db, variantId, now - DAY)]);
  return {
    onSaleSince: settings.onSaleSince,
    cues: resolveBoxCues(settings.page, {
      available,
      soldLast24Hours: sold,
      onSaleSince: settings.onSaleSince,
      now,
    }),
  };
}
