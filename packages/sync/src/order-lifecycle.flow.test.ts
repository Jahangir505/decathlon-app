/**
 * OrderLifecycleSync end to end, against an in-memory stand-in for the repositories and a scripted
 * Decathlon client. What's under test is the flow logic — idempotency, all-or-nothing, and what
 * happens when Decathlon refuses or doesn't answer — not Prisma or HTTP.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DecathlonApiError, DecathlonOutcomeUnknownError } from "@shopify-decathlon/shared";
import { OrderLifecycleSync, type OrderLifecycleDeps } from "./order-lifecycle";
import type { FulfillmentSyncJobPayload, RefundSyncJobPayload } from "./queues";
import { CARRIERS, decathlonOrder, orderLine } from "./test-fixtures";

type Row = Record<string, any>;

function fakeRepositories() {
  const db = {
    orders: [] as Row[],
    shipments: [] as Row[],
    refunds: [] as Row[],
    returns: [] as Row[],
    jobs: [] as Row[],
    logs: [] as Row[],
    config: { refundReasonCode: null as string | null },
  };
  let seq = 0;
  const id = () => `id${++seq}`;
  const claimIn = (table: Row[], key: string, value: string, extra: Row) => {
    const existing = table.find((r) => r[key] === value);
    if (!existing) {
      const row = { id: id(), status: "PROCESSING", lastError: null, decathlonRefundIds: null, ...extra, [key]: value };
      table.push(row);
      return row;
    }
    if (existing.status !== "FAILED") return null;
    Object.assign(existing, { status: "PROCESSING", lastError: null });
    return existing;
  };
  const copy = (r: Row | undefined) => (r ? { ...r } : null);
  const withLines = (o: Row | undefined) => (o ? { ...o, lineItems: o.lineItems } : null);

  const repositories = {
    orderMappings: {
      findByShopifyOrderIdWithLines: async (_s: string, sid: string) => withLines(db.orders.find((o) => o.shopifyOrderId === sid)),
      findByShopifyOrderId: async (_s: string, sid: string) => db.orders.find((o) => o.shopifyOrderId === sid) ?? null,
      findByDecathlonOrderId: async (_s: string, did: string) => db.orders.find((o) => o.decathlonOrderId === did) ?? null,
      findByCommercialId: async (_s: string, cid: string) => db.orders.find((o) => o.decathlonCommercialId === cid) ?? null,
      rekey: async (oid: string, decathlonOrderId: string, decathlonCommercialId: string) =>
        Object.assign(db.orders.find((o) => o.id === oid)!, { decathlonOrderId, decathlonCommercialId }),
      recordShipment: async (_s: string, did: string, decathlonShipmentId: string, shopifyFulfillmentId?: string) =>
        Object.assign(db.orders.find((o) => o.decathlonOrderId === did)!, { decathlonShipmentId, shopifyFulfillmentId }),
      updateStatus: async (_s: string, did: string, decathlonOrderStatus: string) =>
        Object.assign(db.orders.find((o) => o.decathlonOrderId === did)!, { decathlonOrderStatus }),
    },
    shipmentMappings: {
      findByFulfillment: async (_s: string, fid: string) => copy(db.shipments.find((r) => r.shopifyFulfillmentId === fid)),
      claim: async (shopId: string, orderMappingId: string, fid: string) => claimIn(db.shipments, "shopifyFulfillmentId", fid, { shopId, orderMappingId }),
      update: async (rid: string, data: Row) => Object.assign(db.shipments.find((r) => r.id === rid)!, data),
    },
    refundMappings: {
      claim: async (shopId: string, orderMappingId: string, rid: string) => claimIn(db.refunds, "shopifyRefundId", rid, { shopId, orderMappingId }),
      finish: async (rid: string, status: string, data: Row = {}) =>
        Object.assign(db.refunds.find((r) => r.id === rid)!, { status, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) }),
    },
    returnMappings: {
      // Copies, like Prisma — callers compare a row read before an update with the update's result.
      findByDecathlonReturnId: async (_s: string, rid: string) => copy(db.returns.find((r) => r.decathlonReturnId === rid)),
      upsert: async (shopId: string, orderMappingId: string, rid: string, data: Row) => {
        const existing = db.returns.find((r) => r.decathlonReturnId === rid);
        if (existing) return Object.assign(existing, data);
        const row = { id: id(), shopId, orderMappingId, decathlonReturnId: rid, ...data };
        db.returns.push(row);
        return row;
      },
      listOpen: async (_s: string, terminal: string[]) =>
        db.returns.filter((r) => !terminal.includes(r.status)).map((r) => ({ ...r, orderMapping: db.orders.find((o) => o.id === r.orderMappingId) })),
    },
    syncJobs: {
      create: async (_s: string, type: string) => {
        const row = { id: id(), type, status: "PENDING" };
        db.jobs.push(row);
        return row;
      },
      start: async (jid: string) => void Object.assign(db.jobs.find((j) => j.id === jid) ?? {}, { status: "PROCESSING" }),
      finish: async (jid: string, status: string, lastError?: string) => void Object.assign(db.jobs.find((j) => j.id === jid)!, { status, lastError }),
    },
    syncLogs: { write: async (row: Row) => (db.logs.push(row), row) },
    syncConfigurations: { getOrCreateDefault: async () => db.config },
  };
  return { db, repositories };
}

function fakeDecathlon(orders: ReturnType<typeof decathlonOrder>[]) {
  return {
    getOrders: vi.fn(async (ids: string[]) => orders.filter((o) => ids.includes(o.order_id!))),
    listCarriers: vi.fn(async () => CARRIERS),
    createShipments: vi.fn(async (shipments: Row[]) => ({ shipment_success: shipments.map((_, i) => ({ id: `ship-${i + 1}` })), shipment_errors: [] })),
    updateShipmentTracking: vi.fn(async () => ({ shipment_errors: [], shipment_success: [{ id: "ship-1" }] })),
    refundOrderLines: vi.fn(async (refunds: Row[]) => ({ order_tax_mode: "TAX_INCLUDED", refunds: refunds.map((_, i) => ({ refund_id: `r${i + 1}` })) })), // live shape
    listReturns: vi.fn(async (_p?: Row) => ({ data: [] as Row[], next_page_token: null })),
  };
}

const SHOP = "shop1";
const ORDER_GID = "gid://shopify/Order/777";

function setup(opts: { dOrder?: ReturnType<typeof decathlonOrder>; legacy?: boolean } = {}) {
  const { db, repositories } = fakeRepositories();
  const dOrder = opts.dOrder ?? decathlonOrder();
  db.orders.push({
    id: "om1",
    shopId: SHOP,
    shopifyOrderId: ORDER_GID,
    decathlonOrderId: opts.legacy ? dOrder.commercial_id : dOrder.order_id,
    decathlonCommercialId: opts.legacy ? null : dOrder.commercial_id,
    decathlonOrderStatus: dOrder.order_state,
    lineItems: dOrder.order_lines!.map((l) => ({
      decathlonOrderLineId: l.order_line_id,
      sku: l.offer_sku,
      quantity: l.quantity,
      currency: dOrder.currency_iso_code,
      productMapping: { shopifyVariantId: `gid://shopify/ProductVariant/${l.offer_sku}` },
    })),
  });
  const decathlon = fakeDecathlon([dOrder]);
  const shopify = { request: vi.fn(async () => ({ tagsAdd: { userErrors: [] } })) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const sync = new OrderLifecycleSync({ repositories, decathlon, shopify, logger } as unknown as OrderLifecycleDeps);
  return { db, decathlon, shopify, sync, dOrder };
}

const fulfillment = (over: Partial<FulfillmentSyncJobPayload> = {}): FulfillmentSyncJobPayload => ({
  shopId: SHOP,
  shopifyOrderId: ORDER_GID,
  shopifyFulfillmentId: "555",
  status: "success",
  trackingCompany: "Royal Mail",
  trackingNumber: "RM123",
  lines: [{ decathlonOrderLineId: "GB5TEST-A-1", quantity: 1 }],
  ...over,
});

const refund = (over: Partial<RefundSyncJobPayload> = {}): RefundSyncJobPayload => ({
  shopId: SHOP,
  shopifyOrderId: ORDER_GID,
  mode: "refund",
  shopifyRefundId: "9",
  lines: [{ decathlonOrderLineId: "GB5TEST-A-1", quantity: 1, amount: 20 }],
  shippingAmount: 5,
  ...over,
});

// ── Fulfillment ──────────────────────────────────────────────────────────────────────────────────

describe("syncFulfillment", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("creates one ST01 shipment with mapped lines and carrier code", async () => {
    await t.sync.syncFulfillment(fulfillment());
    expect(t.decathlon.createShipments).toHaveBeenCalledWith([
      { order_id: "GB5TEST-A", shipped: true, shipment_lines: [{ order_line_id: "GB5TEST-A-1", quantity: 1 }], tracking: { carrier_code: "RoyalMail", tracking_number: "RM123" } },
    ]);
    expect(t.db.shipments[0]).toMatchObject({ status: "SUCCESS", decathlonShipmentId: "ship-1", carrierCode: "RoyalMail", trackingNumber: "RM123" });
    expect(t.db.orders[0]).toMatchObject({ decathlonShipmentId: "ship-1", shopifyFulfillmentId: "555" });
    expect(t.db.logs.at(-1)).toMatchObject({ type: "FULFILLMENT_SYNC", status: "SUCCESS" });
    expect(t.db.jobs.at(-1)!.status).toBe("SUCCESS");
  });

  it("ignores orders that didn't come from Decathlon", async () => {
    await t.sync.syncFulfillment(fulfillment({ shopifyOrderId: "gid://shopify/Order/1" }));
    expect(t.decathlon.createShipments).not.toHaveBeenCalled();
    expect(t.db.logs).toHaveLength(0);
    expect(t.db.jobs.at(-1)!.status).toBe("SKIPPED");
  });

  it("does not ship twice when the same webhook is delivered again", async () => {
    await t.sync.syncFulfillment(fulfillment());
    await t.sync.syncFulfillment(fulfillment());
    expect(t.decathlon.createShipments).toHaveBeenCalledTimes(1);
    expect(t.decathlon.updateShipmentTracking).not.toHaveBeenCalled();
    expect(t.db.jobs.at(-1)!).toMatchObject({ status: "SKIPPED", lastError: "Tracking unchanged" });
  });

  it("sends a tracking change on an already-shipped fulfillment through ST23", async () => {
    await t.sync.syncFulfillment(fulfillment({ trackingNumber: undefined, trackingCompany: undefined }));
    await t.sync.syncFulfillment(fulfillment({ trackingCompany: "DPD UK", trackingNumber: "DPD9" }));
    expect(t.decathlon.createShipments).toHaveBeenCalledTimes(1);
    expect(t.decathlon.updateShipmentTracking).toHaveBeenCalledWith([{ id: "ship-1", tracking: { carrier_code: "DPDUK", tracking_number: "DPD9" } }]);
    expect(t.db.shipments[0]).toMatchObject({ carrierCode: "DPDUK", trackingNumber: "DPD9" });
  });

  it("treats a 201 carrying shipment_errors as a failure", async () => {
    t.decathlon.createShipments.mockResolvedValueOnce({
      shipment_success: [],
      shipment_errors: [{ order_id: "GB5TEST-A", message: "The order status must be 'SHIPPING' but it is 'CLOSED'." }],
    });
    await t.sync.syncFulfillment(fulfillment());
    expect(t.db.shipments[0]!.status).toBe("FAILED");
    expect(t.db.logs.at(-1)).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("must be 'SHIPPING'") });
  });

  it("allows a retry after a refused shipment", async () => {
    t.decathlon.createShipments.mockResolvedValueOnce({ shipment_success: [], shipment_errors: [{ message: "nope" }] });
    await t.sync.syncFulfillment(fulfillment());
    await t.sync.syncFulfillment(fulfillment());
    expect(t.decathlon.createShipments).toHaveBeenCalledTimes(2);
    expect(t.db.shipments[0]!.status).toBe("SUCCESS");
  });

  it("fails without calling Decathlon when a line can't be matched", async () => {
    await t.sync.syncFulfillment(fulfillment({ lines: [{ sku: "UNKNOWN", quantity: 1 }] }));
    expect(t.decathlon.createShipments).not.toHaveBeenCalled();
    expect(t.db.logs.at(-1)).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("UNKNOWN") });
  });

  it("sends an unknown carrier as free text", async () => {
    await t.sync.syncFulfillment(fulfillment({ trackingCompany: "Evri", trackingUrl: "https://evri/1" }));
    expect(t.decathlon.createShipments.mock.calls[0]![0][0]!.tracking).toEqual({ carrier_name: "Evri", tracking_number: "RM123", tracking_url: "https://evri/1" });
  });

  it("still ships when the carrier list can't be fetched", async () => {
    t.decathlon.listCarriers.mockRejectedValueOnce(new Error("down"));
    await t.sync.syncFulfillment(fulfillment());
    expect(t.decathlon.createShipments.mock.calls[0]![0][0]!.tracking).toEqual({ carrier_name: "Royal Mail", tracking_number: "RM123", tracking_url: undefined });
  });

  it("logs a cancelled fulfillment without touching Decathlon", async () => {
    await t.sync.syncFulfillment(fulfillment({ status: "cancelled" }));
    expect(t.decathlon.createShipments).not.toHaveBeenCalled();
    expect(t.db.logs.at(-1)).toMatchObject({ status: "SKIPPED", errorMessage: expect.stringContaining("cancelled") });
  });

  it("skips pending fulfillments quietly", async () => {
    await t.sync.syncFulfillment(fulfillment({ status: "pending" }));
    expect(t.decathlon.createShipments).not.toHaveBeenCalled();
    expect(t.db.logs).toHaveLength(0);
  });

  it("reports an unconfirmed shipment and points to the Seller Portal", async () => {
    t.decathlon.createShipments.mockRejectedValueOnce(new DecathlonOutcomeUnknownError("POST /api/shipments"));
    await t.sync.syncFulfillment(fulfillment());
    expect(t.db.shipments[0]!.status).toBe("FAILED");
    expect(t.db.logs.at(-1)!.errorMessage).toMatch(/Seller Portal/);
  });
});

// ── Refunds ──────────────────────────────────────────────────────────────────────────────────────

describe("syncRefund", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("sends one OR28 refund and records it", async () => {
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledWith([
      { order_line_id: "GB5TEST-A-1", quantity: 1, amount: 20, shipping_amount: 5, currency_iso_code: "GBP", reason_code: "15" },
    ]);
    expect(t.db.refunds[0]).toMatchObject({ status: "SUCCESS", amount: 25, currency: "GBP", decathlonRefundIds: { before: [], created: ["r1"] } });
    expect(t.db.logs.at(-1)).toMatchObject({ type: "REFUND_SYNC", status: "SUCCESS" });
  });

  it("never refunds the same Shopify refund twice", async () => {
    await t.sync.syncRefund(refund());
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(1);
    expect(t.db.jobs.at(-1)!.status).toBe("SKIPPED");
  });

  it("after an unconfirmed attempt that DID go through, a retry does not resend", async () => {
    t.decathlon.refundOrderLines.mockRejectedValueOnce(new DecathlonOutcomeUnknownError("PUT /api/orders/refund"));
    await t.sync.syncRefund(refund());
    expect(t.db.refunds[0]).toMatchObject({ status: "FAILED", decathlonRefundIds: { before: [] } });

    // Decathlon applied it after all: the line now carries a refund that wasn't there before.
    t.dOrder.order_lines![0]!.refunds = [{ id: "1224", amount: 20, quantity: 1, shipping_amount: 5 }];
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(1);
    expect(t.db.refunds[0]).toMatchObject({ status: "SUCCESS", decathlonRefundIds: { before: [], created: ["1224"] } });
  });

  it("after an unconfirmed attempt that did NOT go through, a retry resends", async () => {
    t.decathlon.refundOrderLines.mockRejectedValueOnce(new DecathlonOutcomeUnknownError("PUT /api/orders/refund"));
    await t.sync.syncRefund(refund());
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(2);
    expect(t.db.refunds[0]!.status).toBe("SUCCESS");
  });

  it("the baseline is the state before the FIRST attempt, not the retry", async () => {
    t.dOrder.order_lines![0]!.refunds = [{ id: "old", amount: 1, quantity: 0, shipping_amount: 0 }];
    t.decathlon.refundOrderLines.mockRejectedValueOnce(new DecathlonOutcomeUnknownError("PUT /api/orders/refund"));
    await t.sync.syncRefund(refund());
    t.dOrder.order_lines![0]!.refunds!.push({ id: "new", amount: 19, quantity: 1, shipping_amount: 5 });
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(1);
    expect(t.db.refunds[0]!.decathlonRefundIds).toEqual({ before: ["old"], created: ["new"] });
  });

  it("records Decathlon's refusal as a failure", async () => {
    t.decathlon.refundOrderLines.mockRejectedValueOnce(
      new DecathlonApiError("Decathlon API request failed: PUT /api/orders/refund -> 400: amount must be lower than the remaining amount", "/api/orders/refund", 400),
    );
    await t.sync.syncRefund(refund());
    expect(t.db.refunds[0]!.status).toBe("FAILED");
    expect(t.db.logs.at(-1)!.errorMessage).toMatch(/remaining amount/);
  });

  it("refuses to half-apply a refund with an unmatched line", async () => {
    await t.sync.syncRefund(refund({ lines: [{ decathlonOrderLineId: "GB5TEST-A-1", quantity: 1, amount: 20 }, { sku: "NOPE", quantity: 1, amount: 5 }] }));
    expect(t.decathlon.refundOrderLines).not.toHaveBeenCalled();
    expect(t.db.refunds[0]!.status).toBe("FAILED");
  });

  it("skips a refund with nothing left to refund", async () => {
    t.dOrder.order_lines![0]!.refunds = [{ id: "1", amount: 20, quantity: 1, shipping_amount: 5 }];
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).not.toHaveBeenCalled();
    expect(t.db.refunds[0]!.status).toBe("SKIPPED");
  });

  it("uses the configured reason", async () => {
    t.db.config.refundReasonCode = "19";
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines.mock.calls[0]![0][0]!.reason_code).toBe("19");
  });

  it("cancellation refunds everything left on unshipped lines", async () => {
    const t2 = setup({
      dOrder: decathlonOrder({
        order_lines: [
          orderLine({ order_line_id: "GB5TEST-A-1", order_line_state: "SHIPPING", price: 20, shipping_price: 5 }),
          orderLine({ order_line_id: "GB5TEST-A-2", offer_sku: "SKU-2", order_line_state: "SHIPPED", price: 10, shipping_price: 0 }),
        ],
      }),
    });
    await t2.sync.syncRefund({ shopId: SHOP, shopifyOrderId: ORDER_GID, mode: "cancel" });
    expect(t2.decathlon.refundOrderLines).toHaveBeenCalledWith([
      { order_line_id: "GB5TEST-A-1", quantity: 1, amount: 20, shipping_amount: 5, currency_iso_code: "GBP", reason_code: "15" },
    ]);
    expect(t2.db.refunds[0]!.shopifyRefundId).toBe(`cancel:${ORDER_GID}`);
    expect(t2.db.logs.at(-1)!.errorMessage).toMatch(/GB5TEST-A-2 is already SHIPPED/);
  });

  it("a cancellation after a full Shopify refund sends nothing more", async () => {
    await t.sync.syncRefund(refund());
    t.dOrder.order_lines![0]!.refunds = [{ id: "r1", amount: 20, quantity: 1, shipping_amount: 5 }];
    await t.sync.syncRefund({ shopId: SHOP, shopifyOrderId: ORDER_GID, mode: "cancel" });
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when the order is gone from Decathlon", async () => {
    t.decathlon.getOrders.mockResolvedValue([]);
    await t.sync.syncRefund(refund());
    expect(t.decathlon.refundOrderLines).not.toHaveBeenCalled();
    expect(t.db.logs.at(-1)!.errorMessage).toMatch(/not found/);
  });
});

// ── Legacy order ids ─────────────────────────────────────────────────────────────────────────────

describe("orders imported before the order_id fix", () => {
  it("are rekeyed to the real order_id before the refund is sent", async () => {
    const t = setup({ legacy: true });
    expect(t.db.orders[0]!.decathlonOrderId).toBe("GB5TEST");
    await t.sync.syncRefund(refund());
    expect(t.db.orders[0]).toMatchObject({ decathlonOrderId: "GB5TEST-A", decathlonCommercialId: "GB5TEST" });
    expect(t.decathlon.refundOrderLines).toHaveBeenCalledTimes(1);
  });

  it("are left alone when Decathlon doesn't confirm the derived id", async () => {
    const t = setup({ legacy: true });
    t.decathlon.getOrders.mockResolvedValue([]);
    await t.sync.syncFulfillment(fulfillment());
    expect(t.db.orders[0]!.decathlonOrderId).toBe("GB5TEST");
  });
});

// ── Returns ──────────────────────────────────────────────────────────────────────────────────────

describe("syncReturns", () => {
  const ret = (state: string, over: Row = {}) => ({
    id: "ret-1",
    order_id: "GB5TEST-A",
    order_commercial_id: "GB5TEST",
    state,
    reason_code: "RETURN_BROKEN_ITEM",
    return_lines: [{ order_line_id: "GB5TEST-A-1", quantity: 1 }],
    tracking: { carrier_code: "RoyalMail", tracking_number: "RET1" },
    ...over,
  });

  it("records a new return and tags the Shopify order", async () => {
    const t = setup();
    t.decathlon.listReturns.mockResolvedValue({ data: [ret("WAITING_ACCEPTANCE")], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.db.returns[0]).toMatchObject({ decathlonReturnId: "ret-1", status: "WAITING_ACCEPTANCE", reasonCode: "RETURN_BROKEN_ITEM", trackingNumber: "RET1" });
    expect(t.shopify.request).toHaveBeenCalledWith(expect.any(String), { id: ORDER_GID, tags: ["decathlon-return", "decathlon-return-waiting-acceptance"] });
    expect(t.db.logs.at(-1)).toMatchObject({ type: "RETURN_SYNC", status: "SUCCESS" });
  });

  it("only acts again when the state changes", async () => {
    const t = setup();
    t.decathlon.listReturns.mockResolvedValue({ data: [ret("WAITING_ACCEPTANCE")], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.shopify.request).toHaveBeenCalledTimes(1);

    t.decathlon.listReturns.mockResolvedValue({ data: [ret("RECEIVED")], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.shopify.request).toHaveBeenCalledTimes(2);
    expect(t.db.logs.at(-1)!.itemLabel).toMatch(/WAITING_ACCEPTANCE → RECEIVED/);
  });

  it("re-checks an open return that has dropped off the newest page", async () => {
    const t = setup();
    t.decathlon.listReturns.mockResolvedValueOnce({ data: [ret("WAITING_ACCEPTANCE")], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    t.decathlon.listReturns
      .mockResolvedValueOnce({ data: [], next_page_token: null }) // newest page no longer has it
      .mockResolvedValueOnce({ data: [ret("CLOSED")], next_page_token: null }); // per-order lookup
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.decathlon.listReturns).toHaveBeenLastCalledWith({ order_commercial_id: "GB5TEST", limit: 50 });
    expect(t.db.returns[0]!.status).toBe("CLOSED");
  });

  it("ignores returns for orders this app didn't import", async () => {
    const t = setup();
    t.decathlon.listReturns.mockResolvedValue({ data: [ret("CLOSED", { order_id: "OTHER-A", order_commercial_id: "OTHER" })], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.db.returns).toHaveLength(0);
    expect(t.shopify.request).not.toHaveBeenCalled();
  });

  it("finds legacy orders stored under the commercial id", async () => {
    const t = setup({ legacy: true });
    t.decathlon.listReturns.mockResolvedValue({ data: [ret("CLOSED")], next_page_token: null });
    await t.sync.syncReturns({ shopId: SHOP });
    expect(t.db.returns).toHaveLength(1);
  });
});
