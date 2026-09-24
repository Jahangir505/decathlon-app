import type { NormalizedAddress, NormalizedOrder, NormalizedProduct, NormalizedVariant } from "@shopify-decathlon/shared";
import type { OrderCreateAddressInput, OrderCreateLineItemInput, OrderCreateOrderInput, ProductWithVariantsResponse } from "@shopify-decathlon/shopify";
import { ValidationError } from "@shopify-decathlon/shared";
import { DECATHLON_ORDER_LINE_PROPERTY, effectiveProductType, toGid } from "@shopify-decathlon/shopify";
import type { FulfillmentSyncJobPayload, RefundSyncJobPayload, ShopifyLineRef } from "../queues";

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
    status: product.status,
    description: product.descriptionHtml ?? undefined,
    brand: product.vendor ?? undefined,
    categoryCode,
    productType: effectiveProductType(product) || undefined,
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
    const properties = [{ name: DECATHLON_ORDER_LINE_PROPERTY, value: item.decathlonOrderLineId }];
    if (variantId) {
      return { variantId, quantity: item.quantity, priceSet, properties };
    }
    return {
      title: `[UNMATCHED] ${item.title ?? "SKU"} ${item.sku}`.trim(),
      sku: item.sku || undefined,
      quantity: item.quantity,
      priceSet,
      properties,
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

// ── Webhook payloads -> job payloads (fulfillment / refund push-back to Decathlon) ───────────────
// These read Shopify's REST-format webhook bodies (fulfillments/create|update, refunds/create).

interface WebhookLineItem {
  id?: number | string;
  variant_id?: number | string | null;
  sku?: string | null;
  title?: string | null;
  quantity?: number;
  properties?: Array<{ name?: string; value?: unknown }> | null;
}

interface MoneySet {
  shop_money?: { amount?: string };
  presentment_money?: { amount?: string };
}

/** The presentment leg — the order's own (Decathlon) currency — falling back to the plain amount. */
function money(set: MoneySet | undefined, plain: string | number | undefined): number {
  const raw = set?.presentment_money?.amount ?? set?.shop_money?.amount ?? plain;
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Orders imported before 2026-09-21 have neither the line property nor, for lines no product
 * matched, a SKU or variant: their only trace is this app's own title, `[UNMATCHED] SKU <sku>`
 * (confirmed on a real dev-store order). The SKU is the title's last word, so it is read back.
 */
function skuFromUnmatchedTitle(title: string | null | undefined): string | undefined {
  return title?.match(/^\[UNMATCHED\].*?(\S+)\s*$/)?.[1];
}

function lineRef(li: WebhookLineItem | undefined, quantity: number): ShopifyLineRef {
  const prop = li?.properties?.find((p) => p.name === DECATHLON_ORDER_LINE_PROPERTY)?.value;
  return {
    decathlonOrderLineId: typeof prop === "string" && prop ? prop : undefined,
    variantId: li?.variant_id ? toGid("ProductVariant", li.variant_id) : undefined,
    sku: li?.sku || skuFromUnmatchedTitle(li?.title),
    quantity,
  };
}

export function parseFulfillmentWebhook(
  shopId: string,
  body: Record<string, unknown>,
): Omit<FulfillmentSyncJobPayload, "correlationId" | "syncJobId"> | null {
  if (!body.id || !body.order_id) return null;
  const lineItems = (body.line_items as WebhookLineItem[] | undefined) ?? [];
  const numbers = (body.tracking_numbers as string[] | undefined) ?? [];
  const urls = (body.tracking_urls as string[] | undefined) ?? [];
  return {
    shopId,
    shopifyOrderId: toGid("Order", body.order_id as string | number),
    shopifyFulfillmentId: String(body.id),
    status: String(body.status ?? ""),
    trackingCompany: (body.tracking_company as string | null) || undefined,
    trackingNumber: (body.tracking_number as string | null) || numbers[0] || undefined,
    trackingUrl: (body.tracking_url as string | null) || urls[0] || undefined,
    lines: lineItems.map((li) => lineRef(li, li.quantity ?? 0)).filter((l) => l.quantity > 0),
  };
}

/**
 * refunds/create -> a "refund" job. Line amounts are tax-inclusive (subtotal + tax), because OR28
 * works in TAX_INCLUDED mode. When the refund carries transactions, their total is the money the
 * merchant actually gave back and it wins: refunding an item but lowering the amount scales the
 * lines down, and an amount with no items becomes `unallocatedAmount` (a price gesture).
 */
export function parseRefundWebhook(
  shopId: string,
  body: Record<string, unknown>,
): Omit<RefundSyncJobPayload, "correlationId" | "syncJobId"> | null {
  if (!body.id || !body.order_id) return null;

  const refundLines = (body.refund_line_items as Array<{
    quantity?: number;
    subtotal?: string | number;
    total_tax?: string | number;
    subtotal_set?: MoneySet;
    total_tax_set?: MoneySet;
    line_item?: WebhookLineItem;
  }> | undefined) ?? [];
  let lines = refundLines
    .map((rl) => ({ ...lineRef(rl.line_item, rl.quantity ?? 0), amount: money(rl.subtotal_set, rl.subtotal) + money(rl.total_tax_set, rl.total_tax) }))
    .filter((l) => l.quantity > 0 || l.amount > 0);

  // Newer API versions report shipping refunds as refund_shipping_lines; older ones as a negative
  // "shipping_refund" order adjustment. Read whichever is there.
  const shippingLines = (body.refund_shipping_lines as Array<{ subtotal_amount_set?: MoneySet; subtotal_amount?: string }> | undefined) ?? [];
  const adjustments = (body.order_adjustments as Array<{ kind?: string; amount?: string; tax_amount?: string; amount_set?: MoneySet; tax_amount_set?: MoneySet }> | undefined) ?? [];
  const shippingAmount = shippingLines.length
    ? shippingLines.reduce((a, s) => a + money(s.subtotal_amount_set, s.subtotal_amount), 0)
    : Math.abs(
        adjustments
          .filter((a) => a.kind === "shipping_refund")
          .reduce((a, adj) => a + money(adj.amount_set, adj.amount) + money(adj.tax_amount_set, adj.tax_amount), 0),
      );

  const transactions = (body.transactions as Array<{ kind?: string; status?: string; amount?: string; amount_set?: MoneySet }> | undefined) ?? [];
  const refunded = transactions.filter((t) => t.kind === "refund" && t.status === "success");
  let unallocatedAmount = 0;
  if (refunded.length > 0) {
    const moneyBack = refunded.reduce((a, t) => a + money(t.amount_set, t.amount), 0);
    const itemized = lines.reduce((a, l) => a + l.amount, 0) + shippingAmount;
    if (moneyBack < itemized - 0.01) {
      const scale = itemized > 0 ? moneyBack / itemized : 0;
      lines = lines.map((l) => ({ ...l, amount: l.amount * scale }));
      return { shopId, shopifyOrderId: toGid("Order", body.order_id as string | number), mode: "refund", shopifyRefundId: String(body.id), lines, shippingAmount: shippingAmount * scale };
    }
    if (moneyBack > itemized + 0.01) unallocatedAmount = moneyBack - itemized;
  }

  return {
    shopId,
    shopifyOrderId: toGid("Order", body.order_id as string | number),
    mode: "refund",
    shopifyRefundId: String(body.id),
    lines,
    shippingAmount,
    unallocatedAmount: unallocatedAmount || undefined,
  };
}
