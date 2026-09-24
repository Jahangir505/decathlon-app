import { describe, expect, it } from "vitest";
import { normalizeDecathlonOrder } from "./decathlon.adapter";
import { buildShopifyOrderInput, normalizeShopifyProduct, parseFulfillmentWebhook, parseRefundWebhook } from "./shopify.adapter";
import { decathlonOrder, orderLine } from "../test-fixtures";

describe("normalizeDecathlonOrder (real OR11 shape)", () => {
  it("keys the order on order_id and keeps the commercial id separately", () => {
    const n = normalizeDecathlonOrder(decathlonOrder());
    expect(n.externalId).toBe("GB5TEST-A");
    expect(n.commercialId).toBe("GB5TEST");
  });

  it("reads the state from order_state and the date from created_date", () => {
    const n = normalizeDecathlonOrder(decathlonOrder({ order_state: "SHIPPING", created_date: "2026-01-02T03:04:05Z" }));
    expect(n.status).toBe("SHIPPING");
    expect(n.createdAt).toBe("2026-01-02T03:04:05Z");
  });

  it("finds addresses under customer and uses the alpha-2 country", () => {
    const n = normalizeDecathlonOrder(decathlonOrder());
    expect(n.shippingAddress).toMatchObject({ address1: "1 Test St", address2: "Flat 2", city: "London", zip: "N1 1AA", countryCode: "GB" });
    expect(n.billingAddress?.countryCode).toBe("GB");
  });

  it("uses price_unit as the unit price — price is the line total", () => {
    const n = normalizeDecathlonOrder(decathlonOrder({ order_lines: [orderLine({ quantity: 10, price: 20, price_unit: 2 })] }));
    expect(n.items[0]).toMatchObject({ quantity: 10, unitPrice: 2 });
  });

  it("derives the unit price from the line total when price_unit is missing", () => {
    const n = normalizeDecathlonOrder(decathlonOrder({ order_lines: [orderLine({ quantity: 4, price: 20, price_unit: undefined })] }));
    expect(n.items[0]!.unitPrice).toBe(5);
  });

  it("gives every line the order's currency", () => {
    const n = normalizeDecathlonOrder(decathlonOrder({ currency_iso_code: "EUR" }));
    expect(n.items.every((i) => i.currency === "EUR")).toBe(true);
  });

  it("rejects an order without order_id", () => {
    expect(() => normalizeDecathlonOrder(decathlonOrder({ order_id: undefined }))).toThrow(/order_id/);
  });
});

describe("buildShopifyOrderInput", () => {
  it("tags every line with its Decathlon order line id, matched or not", () => {
    const order = normalizeDecathlonOrder(
      decathlonOrder({ order_lines: [orderLine(), orderLine({ order_line_id: "GB5TEST-A-2", offer_sku: "SKU-2" })] }),
    );
    const input = buildShopifyOrderInput(order, new Map([["GB5TEST-A-1", "gid://shopify/ProductVariant/1"]]), "GBP");
    expect(input.lineItems[0]).toMatchObject({ variantId: "gid://shopify/ProductVariant/1", properties: [{ name: "_decathlon_order_line_id", value: "GB5TEST-A-1" }] });
    expect(input.lineItems[1]).toMatchObject({ sku: "SKU-2", properties: [{ name: "_decathlon_order_line_id", value: "GB5TEST-A-2" }] });
    expect((input.lineItems[1] as { title: string }).title).toContain("[UNMATCHED]");
  });
});

describe("parseFulfillmentWebhook", () => {
  const body = {
    id: 555,
    order_id: 777,
    status: "success",
    tracking_company: "Royal Mail",
    tracking_number: null,
    tracking_numbers: ["RM1"],
    tracking_urls: ["https://track/RM1"],
    line_items: [
      { id: 1, variant_id: 11, sku: "SKU-1", quantity: 2, properties: [{ name: "_decathlon_order_line_id", value: "GB5TEST-A-1" }] },
      { id: 2, variant_id: null, sku: "GIFT", quantity: 0, properties: [] },
    ],
  };

  it("maps ids to gids and reads the line property", () => {
    const p = parseFulfillmentWebhook("shop1", body)!;
    expect(p.shopifyOrderId).toBe("gid://shopify/Order/777");
    expect(p.shopifyFulfillmentId).toBe("555");
    expect(p.lines).toEqual([{ decathlonOrderLineId: "GB5TEST-A-1", variantId: "gid://shopify/ProductVariant/11", sku: "SKU-1", quantity: 2 }]);
  });

  it("falls back to the plural tracking fields", () => {
    const p = parseFulfillmentWebhook("shop1", body)!;
    expect(p.trackingNumber).toBe("RM1");
    expect(p.trackingUrl).toBe("https://track/RM1");
  });

  it("recovers the SKU from a pre-fix [UNMATCHED] line that has nothing else", () => {
    const p = parseFulfillmentWebhook("shop1", {
      id: 1,
      order_id: 2,
      status: "success",
      line_items: [{ id: 3, variant_id: null, sku: null, title: "[UNMATCHED] SKU METHEL0153M", quantity: 1, properties: [] }],
    })!;
    expect(p.lines).toEqual([{ decathlonOrderLineId: undefined, variantId: undefined, sku: "METHEL0153M", quantity: 1 }]);
  });

  it("reads the SKU from the new [UNMATCHED] <title> <sku> format too", () => {
    const p = parseFulfillmentWebhook("shop1", {
      id: 1,
      order_id: 2,
      status: "success",
      line_items: [{ id: 3, sku: null, title: "[UNMATCHED] Test T-Shirt SKU-9", quantity: 1 }],
    })!;
    expect(p.lines[0]!.sku).toBe("SKU-9");
  });

  it("returns null for a malformed body", () => {
    expect(parseFulfillmentWebhook("shop1", { status: "success" })).toBeNull();
  });
});

describe("parseRefundWebhook", () => {
  const line = (quantity: number, subtotal: string, tax = "0.00") => ({
    quantity,
    subtotal,
    total_tax: tax,
    subtotal_set: { shop_money: { amount: subtotal }, presentment_money: { amount: subtotal } },
    total_tax_set: { shop_money: { amount: tax }, presentment_money: { amount: tax } },
    line_item: { variant_id: 11, sku: "SKU-1", properties: [{ name: "_decathlon_order_line_id", value: "GB5TEST-A-1" }] },
  });
  const shippingAdj = [{ kind: "shipping_refund", amount: "-5.00", tax_amount: "0.00" }];
  const tx = (amount: string) => [{ kind: "refund", status: "success", amount }];

  it("refunds items (tax-inclusive) plus shipping", () => {
    const p = parseRefundWebhook("shop1", { id: 9, order_id: 777, refund_line_items: [line(1, "16.67", "3.33")], order_adjustments: shippingAdj, transactions: tx("25.00") })!;
    expect(p.mode).toBe("refund");
    expect(p.shopifyRefundId).toBe("9");
    expect(p.lines![0]!.amount).toBeCloseTo(20);
    expect(p.shippingAmount).toBe(5);
    expect(p.unallocatedAmount).toBeUndefined();
  });

  it("prefers refund_shipping_lines over order adjustments", () => {
    const p = parseRefundWebhook("shop1", {
      id: 9,
      order_id: 777,
      refund_line_items: [],
      refund_shipping_lines: [{ subtotal_amount_set: { presentment_money: { amount: "4.00" } } }],
      order_adjustments: shippingAdj,
      transactions: tx("4.00"),
    })!;
    expect(p.shippingAmount).toBe(4);
  });

  it("scales lines down when less money was actually refunded", () => {
    const p = parseRefundWebhook("shop1", { id: 9, order_id: 777, refund_line_items: [line(1, "20.00")], order_adjustments: shippingAdj, transactions: tx("12.50") })!;
    expect(p.lines![0]!.amount).toBeCloseTo(10);
    expect(p.shippingAmount).toBeCloseTo(2.5);
  });

  it("treats money with no items as a price gesture", () => {
    const p = parseRefundWebhook("shop1", { id: 10, order_id: 777, refund_line_items: [], order_adjustments: [], transactions: tx("7.00") })!;
    expect(p.lines).toEqual([]);
    expect(p.unallocatedAmount).toBe(7);
  });

  it("ignores failed transactions", () => {
    const p = parseRefundWebhook("shop1", {
      id: 9,
      order_id: 777,
      refund_line_items: [line(1, "20.00")],
      transactions: [{ kind: "refund", status: "failure", amount: "20.00" }],
    })!;
    expect(p.lines![0]!.amount).toBe(20);
  });

  it("uses line amounts as-is when the refund has no transactions", () => {
    const p = parseRefundWebhook("shop1", { id: 9, order_id: 777, refund_line_items: [line(2, "40.00")] })!;
    expect(p.lines![0]).toMatchObject({ quantity: 2, amount: 40 });
  });
});

describe("normalizeShopifyProduct product type", () => {
  const raw = (productType: string | null, category: { name: string } | null) =>
    ({
      product: {
        id: "gid://shopify/Product/1",
        status: "ACTIVE",
        title: "Tee",
        descriptionHtml: "",
        vendor: "V",
        productType,
        category,
        images: { edges: [] },
        decathlonCategory: null,
        decathlonAttributes: null,
        variants: { edges: [] },
      },
    }) as unknown as Parameters<typeof normalizeShopifyProduct>[0];

  it("prefers the merchant's product type", () => {
    expect(normalizeShopifyProduct(raw("Tees", { name: "T-Shirts" }), "EUR").productType).toBe("Tees");
  });

  it("falls back to the Shopify standard category when the type is blank", () => {
    expect(normalizeShopifyProduct(raw("  ", { name: "T-Shirts" }), "EUR").productType).toBe("T-Shirts");
  });

  it("leaves it unset when neither exists", () => {
    expect(normalizeShopifyProduct(raw("", null), "EUR").productType).toBeUndefined();
  });
});
