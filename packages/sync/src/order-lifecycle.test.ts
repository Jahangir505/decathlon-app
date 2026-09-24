import { describe, expect, it } from "vitest";
import { buildCancellationRefunds, buildRefunds, resolveLines, resolveTracking } from "./order-lifecycle";
import { CARRIERS, orderLine } from "./test-fixtures";

type Lines = Parameters<typeof resolveLines>[0];

const lines = [
  { decathlonOrderLineId: "A-1", sku: "S1", quantity: 2, productMapping: { shopifyVariantId: "gid://shopify/ProductVariant/1" } },
  { decathlonOrderLineId: "A-2", sku: "S2", quantity: 1, productMapping: null },
  { decathlonOrderLineId: "A-3", sku: "S1", quantity: 1, productMapping: { shopifyVariantId: "gid://shopify/ProductVariant/1" } },
] as unknown as Lines;
const order = { lineItems: lines } as unknown as Parameters<typeof buildRefunds>[0];

describe("resolveLines", () => {
  it("prefers the line property", () => {
    const r = resolveLines(lines, [{ decathlonOrderLineId: "A-3", variantId: "gid://shopify/ProductVariant/1", quantity: 1 }]);
    expect(r.resolved).toEqual([expect.objectContaining({ decathlonOrderLineId: "A-3", quantity: 1 })]);
  });

  it("falls back to variant, splitting across lines of the same variant", () => {
    const r = resolveLines(lines, [{ variantId: "gid://shopify/ProductVariant/1", quantity: 3 }]);
    expect(r.resolved.map((x) => [x.decathlonOrderLineId, x.quantity])).toEqual([["A-1", 2], ["A-3", 1]]);
    expect(r.unresolved).toEqual([]);
  });

  it("falls back to SKU", () => {
    const r = resolveLines(lines, [{ sku: "S2", quantity: 1 }]);
    expect(r.resolved[0]!.decathlonOrderLineId).toBe("A-2");
  });

  it("reports the quantity it could not place", () => {
    const r = resolveLines(lines, [{ sku: "S2", quantity: 3 }, { sku: "NOPE", quantity: 1 }]);
    expect(r.unresolved).toEqual([{ sku: "S2", quantity: 2 }, { sku: "NOPE", quantity: 1 }]);
  });

  it("does not reuse capacity already consumed in the same batch", () => {
    const r = resolveLines(lines, [{ decathlonOrderLineId: "A-2", quantity: 1 }, { sku: "S2", quantity: 1 }]);
    expect(r.unresolved).toEqual([{ sku: "S2", quantity: 1 }]);
  });
});

describe("resolveTracking", () => {
  const t = (company?: string, num: string | undefined = "TRK1") => resolveTracking(company, num, "https://t/1", CARRIERS);

  it.each([
    ["Royal Mail", "RoyalMail"],
    ["royalmail", "RoyalMail"],
    ["DPD UK", "DPDUK"],
    ["DPD (UK)", "DPDUK"],
    ["UPS", "UPS"],
    ["UPS (UK)", "UPSUK"],
    ["Parcelforce", "parcelforceUK"],
    ["bpost", "postBE"],
  ])("%s -> %s", (company, code) => {
    expect(t(company)).toEqual({ carrier_code: code, tracking_number: "TRK1" });
  });

  it("sends an unknown carrier as free text with the URL", () => {
    expect(t("Evri")).toEqual({ carrier_name: "Evri", tracking_number: "TRK1", tracking_url: "https://t/1" });
  });

  it("returns nothing when there is neither carrier nor number", () => {
    expect(resolveTracking(undefined, undefined, undefined, CARRIERS)).toBeUndefined();
  });
});

describe("buildRefunds", () => {
  const dLines = [
    orderLine({ order_line_id: "A-1", order_line_state: "SHIPPED", quantity: 2, price: 40, shipping_price: 5 }),
    orderLine({ order_line_id: "A-2", order_line_state: "SHIPPING", quantity: 1, price: 10, shipping_price: 0 }),
    orderLine({ order_line_id: "A-3", order_line_state: "SHIPPED", quantity: 1, price: 20, shipping_price: 0 }),
  ];
  const build = (p: Partial<Parameters<typeof buildRefunds>[2]>, d = dLines, override: string | null = null) =>
    buildRefunds(order, d, { shopId: "s", shopifyOrderId: "o", mode: "refund", ...p }, "GBP", override);

  it("refunds a returned item with its shipping, reason 17", () => {
    const r = build({ lines: [{ decathlonOrderLineId: "A-1", quantity: 1, amount: 20 }], shippingAmount: 5 });
    expect(r.refunds).toEqual([{ order_line_id: "A-1", quantity: 1, amount: 20, shipping_amount: 5, currency_iso_code: "GBP", reason_code: "17" }]);
    expect(r.problems).toEqual([]);
  });

  it("uses reason 15 for a line not shipped yet", () => {
    expect(build({ lines: [{ sku: "S2", quantity: 1, amount: 10 }] }).refunds[0]).toMatchObject({ order_line_id: "A-2", reason_code: "15" });
  });

  it("applies the configured reason override", () => {
    expect(build({ lines: [{ sku: "S2", quantity: 1, amount: 10 }] }, dLines, "16").refunds[0]!.reason_code).toBe("16");
  });

  it("splits the amount proportionally when a quantity spans two lines", () => {
    const r = build({ lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 3, amount: 60 }] });
    expect(r.refunds.map((x) => [x.order_line_id, x.quantity, x.amount])).toEqual([["A-1", 2, 40], ["A-3", 1, 20]]);
  });

  it("caps at what Decathlon still holds and says so", () => {
    const r = build({ lines: [{ decathlonOrderLineId: "A-1", quantity: 2, amount: 55 }] });
    expect(r.refunds[0]!.amount).toBe(40);
    expect(r.problems[0]).toMatch(/capped/);
  });

  it("subtracts refunds Decathlon already made", () => {
    const d = [orderLine({ order_line_id: "A-1", order_line_state: "SHIPPED", quantity: 2, price: 40, shipping_price: 5, refunds: [{ id: "1", amount: 30, quantity: 1, shipping_amount: 5 }] })];
    const r = build({ lines: [{ decathlonOrderLineId: "A-1", quantity: 1, amount: 20 }], shippingAmount: 5 }, d);
    expect(r.refunds[0]).toMatchObject({ amount: 10, shipping_amount: 0, quantity: 1 });
    expect(r.problems.join()).toMatch(/shipping/);
  });

  it("spreads an amount-only gesture as quantity-0 refunds, reason 19", () => {
    const r = build({ lines: [], unallocatedAmount: 45 });
    expect(r.refunds.map((x) => [x.order_line_id, x.quantity, x.amount, x.reason_code])).toEqual([["A-1", 0, 40, "19"], ["A-2", 0, 5, "19"]]);
  });

  it("flags a gesture larger than the whole order", () => {
    expect(build({ lines: [], unallocatedAmount: 100 }).problems[0]).toMatch(/exceeds/);
  });

  it("throws rather than half-applying a refund with an unmatched line", () => {
    expect(() => build({ lines: [{ sku: "S2", quantity: 1, amount: 10 }, { sku: "NOPE", quantity: 1, amount: 5 }] })).toThrow(/NOPE/);
  });

  it("drops lines with nothing to refund (e.g. restock-only)", () => {
    expect(build({ lines: [{ sku: "S2", quantity: 1, amount: 0 }] }).refunds).toEqual([]);
  });

  it("rounds to cents", () => {
    const r = build({ lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 3, amount: 10 }] });
    expect(r.refunds.map((x) => x.amount)).toEqual([6.67, 3.33]);
  });
});

describe("buildCancellationRefunds", () => {
  it("refunds everything left on unshipped lines only", () => {
    const d = [
      orderLine({ order_line_id: "A-1", order_line_state: "SHIPPING", quantity: 2, price: 40, shipping_price: 5, refunds: [{ id: "1", amount: 10, quantity: 0, shipping_amount: 0 }] }),
      orderLine({ order_line_id: "A-2", order_line_state: "SHIPPED", price: 10 }),
      orderLine({ order_line_id: "A-3", order_line_state: "CLOSED", price: 10 }),
    ];
    const r = buildCancellationRefunds(d, "GBP", null);
    expect(r.refunds).toEqual([{ order_line_id: "A-1", quantity: 2, amount: 30, shipping_amount: 5, currency_iso_code: "GBP", reason_code: "15" }]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/A-2 is already SHIPPED/);
  });

  it("skips fully refunded and non-refundable lines", () => {
    const d = [
      orderLine({ order_line_id: "A-1", price: 20, shipping_price: 5, refunds: [{ id: "1", amount: 20, quantity: 1, shipping_amount: 5 }] }),
      orderLine({ order_line_id: "A-2", can_refund: false }),
    ];
    expect(buildCancellationRefunds(d, "GBP", null).refunds).toEqual([]);
  });
});
