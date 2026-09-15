/** One product a pool can fill a box from, as the admin sees it (migration 1220). */
export interface PoolItem {
  variantId: string;
  productTitle: string;
  sku: string;
  optionValues: Record<string, string>;
  colorHex: string | null;
  imageId: string | null;
  available: number;
}

export interface PoolPreview {
  tag: string;
  /** In-stock pool units, minus what held carts and unfilled paid boxes already owe. */
  freeUnits: number;
  items: PoolItem[];
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

/** An order line that is a box, whether or not any of its boxes is filled yet. */
export interface BoxLine {
  orderLineId: string;
  poolTag: string | null;
  itemCount: number | null;
}
