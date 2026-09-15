import type { BoxPage } from '../../../shared/commerce/mystery-box';

/** One variant on a mystery box list, as Settings shows it (migration 1240). */
export interface MysteryBoxItem {
  variantId: string;
  list: 'main' | 'backup';
  productId: string;
  productTitle: string;
  sku: string;
  optionValues: Record<string, string>;
  colorHex: string | null;
  imageId: string | null;
  /** On the shelf now, less what carts are holding. */
  available: number;
  /** False when the product or variant can't currently be used (draft, discontinued, trashed). */
  usable: boolean;
}

/**
 * The mystery box itself: a product the box owns (migration 1240), hidden from
 * the Products list and edited only on Settings → Mystery box. One price, one
 * number of items per box.
 */
export interface MysteryBoxProduct {
  productId: string;
  variantId: string;
  slug: string | null;
  status: string;
  name: string;
  /** Migration 1260: the size shown on the shop ("Large"), stored as the variant's Size option. */
  size: string | null;
  description: unknown;
  /** The owner's overview, or null when the shop derives it from the description. */
  overview: string | null;
  /** What the shop shows when `overview` is null. */
  overviewFallback: string;
  coverImageId: string | null;
  imageIds: string[];
  /** Minor units; null until a price is set. */
  priceMinor: number | null;
  currency: string;
  itemCount: number | null;
  /** How many more boxes can be bought right now. */
  canBuy: number;
  /** Boxes built ahead and on the shelf. */
  ready: number;
  /** Boxes paid for in the last 24 hours, for the "selling fast" cue. */
  soldLast24Hours: number;
}

export interface MysteryBoxSettings {
  enabled: boolean;
  mode: 'pack' | 'built' | 'auto';
  shortfall: 'hold' | 'backup' | 'cancel_refund';
  revision: number;
  updatedAt: number;
  /** Migration 1260: the words and cues the shop shows on the box. */
  page: BoxPage;
  /** When the box was last switched on; null while it is off. */
  onSaleSince: number | null;
}

export interface MysteryBoxView {
  settings: MysteryBoxSettings;
  /** Null until the screen is saved for the first time. */
  box: MysteryBoxProduct | null;
  /** What the shop shows while the box has no pictures or description of its own. */
  fallback: { imageIds: string[]; line: string; productTitles: string[] };
  items: MysteryBoxItem[];
  built: BuiltBox[];
}

export interface BoxFillItem {
  id: string;
  position: number;
  variantId: string;
  sku: string;
  title: string;
  optionValues: Record<string, string>;
  imageId: string | null;
  returnedToStockAt: number | null;
}

export interface BoxFill {
  id: string;
  orderLineId: string;
  boxNo: number;
  source: 'hand' | 'built' | 'auto' | 'backup';
  fulfillmentId: string | null;
  filledBy: string | null;
  filledAt: number;
  items: BoxFillItem[];
}

/** A box built ahead and still on the shelf (migration 1240). */
export interface BuiltBox {
  id: string;
  sizeVariantId: string;
  filledAt: number;
  items: BoxFillItem[];
}

/** An order line that is a mystery box, whether or not any of its boxes is filled yet. */
export interface BoxLine {
  orderLineId: string;
  itemCount: number | null;
}
