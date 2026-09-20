/**
 * Applies the shop's configured markup then discount to a Shopify variant price to get the price
 * pushed to Decathlon via OF01/OF24 (docs/sync-strategy.md §6). No currency conversion is performed.
 * Plain numbers in/out (not Prisma's Decimal type) so this stays decoupled from @prisma/client —
 * callers convert `SyncConfiguration.priceMarkupPercent`/`priceDiscountPercent` (Decimal | null) via
 * `Number(...)` before calling this.
 */
export function computeOfferPrice(
  variantPrice: number,
  markupPercent: number | null | undefined,
  discountPercent: number | null | undefined,
): number {
  let price = variantPrice;
  if (markupPercent) price *= 1 + markupPercent / 100;
  if (discountPercent) price *= 1 - discountPercent / 100;
  return Math.max(0, Math.round(price * 100) / 100);
}

/** Never push negative stock (docs/sync-strategy.md §8). */
export function clampQuantity(quantity: number): number {
  return Math.max(0, Math.trunc(quantity));
}
