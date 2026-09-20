import type { NormalizedAddress, NormalizedOrder, NormalizedProduct, NormalizedVariant } from "@shopify-decathlon/shared";
import type { OrderCreateAddressInput, OrderCreateLineItemInput, OrderCreateOrderInput, ProductWithVariantsResponse } from "@shopify-decathlon/shopify";
import { ValidationError } from "@shopify-decathlon/shared";

/**
 * Shopify GraphQL response -> normalized model. Per docs/architecture.md §3 (hexagonal rule), this
 * is the ONLY place Shopify-specific shapes get translated into the shared NormalizedProduct model
 * that packages/sync and the Decathlon adapter deal with.
 *
 * The Decathlon category (H11 hierarchy code) is left UNRESOLVED here: a per-product
 * `custom.decathlon_category` metafield is read when present, but the usual source is the shop's
 * CategoryMapping rule for the product's type, which needs a database lookup this pure adapter
 * deliberately doesn't do. SyncEngine.resolveCategoryCode fills it in and raises the "no category"
 * error, so this function stays free of I/O.
 */
export function normalizeShopifyProduct(raw: ProductWithVariantsResponse, defaultCurrency: string): NormalizedProduct {
  const product = raw.product;
  if (!product) {
    throw new ValidationError("Shopify product not found (deleted, or id no longer valid)");
  }

  const categoryCode = product.decathlonCategory?.value || undefined;

  // Optional per-product overrides for Decathlon attributes Shopify has no field for (e.g. the sport,
  // a category-specific size list) — a JSON object of attribute code -> value, resolved against
  // Decathlon's own value lists in packages/sync's payload builder. A malformed value is a hard,
  // deterministic error so the merchant sees exactly which product to fix.
  let attributes: Record<string, string> | undefined;
  const rawAttributes = product.decathlonAttributes?.value;
  if (rawAttributes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAttributes);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError(
        `Shopify product ${product.id} has an invalid "custom.decathlon_attributes" metafield — it must be a JSON object of Decathlon attribute code -> value, e.g. {"SPORT_ALL": "indoor cycling"}`,
      );
    }
    attributes = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
        .map(([k, v]) => [k.trim(), String(v).trim()]),
    );
  }

  const variants: NormalizedVariant[] = product.variants.edges.map(({ node }) => {
    const available = node.inventoryItem.inventoryLevels.edges
      .flatMap((e) => e.node.quantities)
      .filter((q) => q.name === "available")
      .reduce((sum, q) => sum + q.quantity, 0);

    const optionValues: Record<string, string> = {};
    for (const opt of node.selectedOptions) {
      optionValues[opt.name] = opt.value;
    }

    if (!node.sku) {
      throw new ValidationError(`Shopify variant ${node.id} has no SKU set — required as the Decathlon shop_sku`);
    }

    return {
      shopifyVariantId: node.id,
      sku: node.sku,
      ean: node.barcode ?? undefined,
      price: Number(node.price),
      // ProductVariant has no currency field of its own (price is a plain decimal string) — the
      // shop's currency comes from the caller (SyncConfiguration.defaultCurrency), not Shopify.
      currency: defaultCurrency,
      inventoryQuantity: available,
      optionValues,
    };
  });

  return {
    externalId: undefined, // populated once ProductMapping.decathlonProductId is known
    shopSku: variants[0]?.sku ?? product.id,
    title: product.title,
    description: product.descriptionHtml ?? undefined,
    brand: product.vendor ?? undefined,
    categoryCode,
    productType: product.productType ?? undefined,
    images: product.images.edges.map((e) => e.node.url),
    variants,
    attributes,
  };
}

/**
 * NormalizedOrder -> Shopify orderCreate input. Unmatched lines (no ProductMapping found) are NOT
 * dropped — they're included as custom (variant-less) line items so order totals stay correct, while
 * the mapping layer (OrderLineItem.productMappingId left null) is what actually flags them for
 * manual resolution (docs/sync-strategy.md §1).
 */
export function buildShopifyOrderInput(
  order: NormalizedOrder,
  matchedVariantIdByLineId: Map<string, string>,
  shopCurrency: string,
): OrderCreateOrderInput {
  const lineItems: OrderCreateLineItemInput[] = order.items.map((item) => {
    const variantId = matchedVariantIdByLineId.get(item.decathlonOrderLineId);
    // shopMoney must be denominated in the shop's own currency (Shopify rejects it otherwise —
    // see docs/api-mapping.md §4 item 7); presentmentMoney is what Decathlon actually charged, in
    // the order's own currency. We don't do real FX conversion, so shopMoney reuses the raw amount
    // under the shop's currency code rather than a converted figure.
    const priceSet = {
      shopMoney: { amount: item.unitPrice.toFixed(2), currencyCode: shopCurrency },
      presentmentMoney: { amount: item.unitPrice.toFixed(2), currencyCode: item.currency },
    };
    if (variantId) {
      return { variantId, quantity: item.quantity, priceSet };
    }
    return {
      title: `[UNMATCHED] SKU ${item.sku}`,
      quantity: item.quantity,
      priceSet,
    };
  });

  return {
    email: order.customer?.email,
    currency: shopCurrency,
    presentmentCurrency: order.currency,
    financialStatus: "PAID",
    lineItems,
    shippingAddress: toAddressInput(order.shippingAddress),
    billingAddress: toAddressInput(order.billingAddress),
    tags: ["decathlon", `decathlon-order:${order.externalId}`],
    note: `Imported from Decathlon Partner order ${order.externalId}`,
  };
}

function toAddressInput(addr: NormalizedAddress | undefined): OrderCreateAddressInput | undefined {
  if (!addr) return undefined;
  return { ...addr };
}
