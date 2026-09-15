import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { docToText } from '../../../shared/doc';
import type { DocNode } from '../../../shared/types';
import { normalizeBlobId, publicImageUrl } from '../../repo/public-projection';

/**
 * WHAT THE MYSTERY BOX SHOWS UNTIL THE OWNER GIVES IT ITS OWN PICTURES AND
 * WORDS (owner's decision 2026-09-15): the cover photos of the products that can
 * go inside, and one generated line naming them. It follows the tick list, so it
 * changes as products are ticked and unticked.
 *
 * Only ACTIVE products on the main list: their covers are the only ones the public
 * image route will serve, and a draft has no business on the shop's page.
 */
export interface BoxFallback {
  /** Cover image ids, one per product, in list order. */
  imageIds: string[];
  /** e.g. "A surprise mix of PLA Silk and PLA+." — empty when nothing is ticked. */
  line: string;
  productTitles: string[];
}

export async function boxFallback(db: Db): Promise<BoxFallback> {
  const res = await db.execute(sql`
    SELECT p.title, p.cover_image_id
      FROM shop_products p
     WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.box_mode IS NULL
       AND EXISTS (SELECT 1 FROM shop_mystery_box_items mi
                     JOIN shop_variants v ON v.id = mi.variant_id
                    WHERE mi.list = 'main' AND v.product_id = p.id AND v.status = 'active')
     ORDER BY lower(p.title)`);
  const titles = res.rows.map((r) => String(r.title));
  const imageIds = res.rows
    .map((r) => (r.cover_image_id == null ? '' : normalizeBlobId(String(r.cover_image_id))))
    .filter((id) => id !== '');
  /* Product titles often carry a long spec tail ("PLA Silk - 1.75mm 3D Printer
     Filament"); the part before the first " - " reads as a name in a sentence. */
  const short = titles.map((t) => t.split(' - ')[0].trim()).filter(Boolean);
  const named =
    short.length === 0
      ? ''
      : short.length === 1
        ? short[0]
        : `${short.slice(0, -1).join(', ')} and ${short[short.length - 1]}`;
  return { imageIds, line: named ? `A surprise mix of ${named}.` : '', productTitles: titles };
}

/** A paragraph document holding one line of text. */
export const lineDoc = (line: string): DocNode =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: line }] }] }) as DocNode;

/**
 * Fill in a storefront product's pictures and words from the fallback, but only
 * where the box has none of its own. Anything the owner has set always wins.
 */
export function withBoxFallback<
  T extends {
    boxMode: string | null;
    coverImageUrl: string | null;
    imageUrls: string[];
    description: DocNode;
    overview: string;
  },
>(product: T, fallback: BoxFallback | null): T {
  if (product.boxMode === null || fallback === null) return product;
  const next = { ...product };
  if (next.coverImageUrl === null && next.imageUrls.length === 0 && fallback.imageIds.length > 0) {
    const urls = fallback.imageIds.map(publicImageUrl);
    next.coverImageUrl = urls[0];
    next.imageUrls = urls;
  }
  /* Keyed on the OVERVIEW, not the description: the list route carries an empty
     description for every product (it isn't in the list columns), while the
     overview is derived from the real description on both routes. So an empty
     overview is the one honest signal that the owner has written nothing. */
  if (fallback.line && !next.overview && docToText(next.description).trim() === '') {
    next.description = lineDoc(fallback.line);
    next.overview = fallback.line;
  }
  return next;
}
