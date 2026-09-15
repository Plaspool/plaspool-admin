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

/** One size of the mystery box: a variant of the product it is sold as. */
export interface MysteryBoxSize {
  variantId: string;
  sku: string;
  optionValues: Record<string, string>;
  itemCount: number | null;
  /** How many more of this size can be sold now. */
  canFill: number;
  /** Boxes of this size built ahead and on the shelf. */
  ready: number;
}

export interface MysteryBoxSettings {
  enabled: boolean;
  productId: string | null;
  productTitle: string | null;
  productStatus: string | null;
  mode: 'pack' | 'built' | 'auto';
  shortfall: 'hold' | 'backup' | 'cancel_refund';
  revision: number;
  updatedAt: number;
}

export interface MysteryBoxView {
  settings: MysteryBoxSettings;
  sizes: MysteryBoxSize[];
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
