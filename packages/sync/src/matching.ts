import type { ProductMapping, Repositories } from "@shopify-decathlon/database";
import type { DecathlonClient } from "@shopify-decathlon/decathlon";
import type { NormalizedOrderItem } from "@shopify-decathlon/shared";

export interface MatchingDeps {
  repositories: Repositories;
  decathlon: DecathlonClient;
}

/**
 * Matching priority for Shopify -> Decathlon product sync (docs/sync-strategy.md §1):
 *   1. An existing ProductMapping row for this exact Shopify variant (fastest path, whether or not
 *      it has a decathlonProductId yet — a PENDING row still means "don't treat this as brand new").
 *   2. shopSku via P31 (GET /api/products) — detects a listing that already exists on Decathlon
 *      which this app doesn't have a local mapping for yet (avoids creating a duplicate listing).
 *   3. Never match on title.
 * ean is documented as a secondary check but Decathlon's P31 is a shop_sku lookup, not an ean
 * lookup (no confirmed ean-based Decathlon endpoint exists) — so step 2's remote check is SKU-only;
 * a local ean fallback is used only for order-line matching (see matchOrderLine below), where it
 * has a confirmed use (matching an inbound order line against mappings created by product sync).
 */
export async function matchProductMapping(
  deps: MatchingDeps,
  shopId: string,
  variant: { shopifyVariantId: string; shopSku: string },
): Promise<{ mapping: ProductMapping | null; existingDecathlonProductId?: string }> {
  const existing = await deps.repositories.productMappings.findByVariant(shopId, variant.shopifyVariantId);
  if (existing) {
    return { mapping: existing };
  }

  // No local mapping yet — check whether Decathlon already has this shop_sku listed (P31), so we
  // don't create a second listing for something already there (e.g. listed before this app existed).
  try {
    const raw = (await deps.decathlon.getProducts([variant.shopSku])) as
      | { products?: Array<{ id?: string; shop_sku?: string }>; data?: Array<{ id?: string; shop_sku?: string }> }
      | undefined;
    const rows = raw?.products ?? raw?.data ?? [];
    const found = rows.find((r) => r.shop_sku === variant.shopSku && r.id);
    if (found?.id) {
      return { mapping: null, existingDecathlonProductId: found.id };
    }
  } catch {
    // P31 lookup is best-effort defense against duplicates, not a hard requirement — if it fails
    // (e.g. still-unconfirmed endpoint behavior), fall through and let P41's own upsert-by-shop_sku
    // behavior be the source of truth.
  }

  return { mapping: null };
}

/**
 * Matching priority for Decathlon -> Shopify order-line matching (docs/sync-strategy.md §1,
 * reversed direction): decathlonProductId/decathlonOfferId -> sku -> ean -> never title. A line
 * matching nothing returns null; the caller must NOT drop it — flag UNMATCHED per requirement §8.
 */
export async function matchOrderLine(
  deps: MatchingDeps,
  shopId: string,
  item: NormalizedOrderItem & { decathlonProductId?: string; decathlonOfferId?: string },
): Promise<ProductMapping | null> {
  if (item.decathlonProductId) {
    const byProductId = await deps.repositories.productMappings.findByDecathlonProductId(shopId, item.decathlonProductId);
    if (byProductId[0]) return byProductId[0];
  }
  if (item.sku) {
    const bySku = await deps.repositories.productMappings.findBySku(shopId, item.sku);
    if (bySku[0]) return bySku[0];
  }
  const ean = (item as { ean?: string }).ean;
  if (ean) {
    const byEan = await deps.repositories.productMappings.findByEan(shopId, ean);
    if (byEan[0]) return byEan[0];
  }
  return null;
}
