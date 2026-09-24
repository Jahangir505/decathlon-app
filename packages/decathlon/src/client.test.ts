import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecathlonApiError, DecathlonOutcomeUnknownError } from "@shopify-decathlon/shared";
import { DecathlonClient } from "./client";

type Call = { method: string; url: URL; body: unknown; headers: Record<string, string> };

let calls: Call[];
let responses: Array<() => Response | Promise<Response>>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const noContent = () => new Response(null, { status: 204 });
const networkError = () => () => Promise.reject(new TypeError("fetch failed"));

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        url: new URL(url),
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        headers: init.headers as Record<string, string>,
      });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
      return next();
    }),
  );
  // Backoff waits are real timers in the client — make them instant.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const client = () => new DecathlonClient({ baseUrl: "https://decathlonbelgium-preprod.mirakl.net", apiKey: "KEY", maxRetries: 3 });

describe("endpoint contracts (confirmed live 2026-09-21)", () => {
  it("authenticates with the bare key, no Bearer prefix", async () => {
    responses.push(json(200, { carriers: [] }));
    await client().listCarriers();
    expect(calls[0]!.headers.Authorization).toBe("KEY");
  });

  it("ST01 createShipments -> POST /api/shipments {shipments}", async () => {
    responses.push(json(201, { shipment_errors: [], shipment_success: [{ id: "s1" }] }));
    const shipment = { order_id: "O-A", shipment_lines: [{ order_line_id: "O-A-1", quantity: 1 }] };
    const res = await client().createShipments([shipment]);
    expect(calls[0]).toMatchObject({ method: "POST", body: { shipments: [shipment] } });
    expect(calls[0]!.url.pathname).toBe("/api/shipments");
    expect(res.shipment_success![0]!.id).toBe("s1");
  });

  it("ST23 updateShipmentTracking -> POST (not PUT) /api/shipments/tracking", async () => {
    responses.push(json(200, { shipment_errors: [], shipment_success: [] }));
    await client().updateShipmentTracking([{ id: "s1", tracking: { carrier_code: "RoyalMail", tracking_number: "T" } }]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/api/shipments/tracking");
  });

  it("OR28 refundOrderLines -> PUT /api/orders/refund {refunds}", async () => {
    responses.push(json(200, { order_tax_mode: "TAX_INCLUDED", refunds: [] }));
    const r = { order_line_id: "O-A-1", quantity: 1, amount: 10, currency_iso_code: "GBP", reason_code: "17" };
    await client().refundOrderLines([r]);
    expect(calls[0]).toMatchObject({ method: "PUT", body: { refunds: [r] } });
    expect(calls[0]!.url.pathname).toBe("/api/orders/refund");
  });

  it("OR23 / OR24 whole-order paths", async () => {
    responses.push(noContent, noContent);
    await client().updateOrderTracking("O-A", { carrier_code: "RoyalMail" });
    await client().markOrderShipped("O-A");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["PUT /api/orders/O-A/tracking", "PUT /api/orders/O-A/ship"]);
  });

  it("OR11 getOrders filters by order_ids", async () => {
    responses.push(json(200, { orders: [{ order_id: "O-A" }], total_count: 1 }));
    const orders = await client().getOrders(["O-A", "O-B"]);
    expect(calls[0]!.url.searchParams.get("order_ids")).toBe("O-A,O-B");
    expect(orders).toEqual([{ order_id: "O-A" }]);
  });

  it("RT11 listReturns passes sort and commercial id", async () => {
    responses.push(json(200, { data: [{ id: "r1" }], next_page_token: null }));
    const res = await client().listReturns({ limit: 50, sort: "date_created,DESC", order_commercial_id: "C1" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ limit: "50", sort: "date_created,DESC", order_commercial_id: "C1" });
    expect(res.data).toEqual([{ id: "r1" }]);
  });

  it("RT29 cancelReturns -> PUT /api/returns/cancel {returns:[{id}]}", async () => {
    responses.push(json(200, { return_errors: [], return_success: [] }));
    await client().cancelReturns(["r1"]);
    expect(calls[0]).toMatchObject({ method: "PUT", body: { returns: [{ id: "r1" }] } });
    expect(calls[0]!.url.pathname).toBe("/api/returns/cancel");
  });

  it("RT12 getItemsToReturn sends the mandatory filter", async () => {
    responses.push(json(200, { data: [] }));
    await client().getItemsToReturn({ order_commercial_id: "C1" });
    expect(calls[0]!.url.searchParams.get("order_commercial_id")).toBe("C1");
  });

  it("URL-encodes order ids in paths", async () => {
    responses.push(noContent);
    await client().markOrderShipped("a/b c");
    expect(calls[0]!.url.pathname).toBe("/api/orders/a%2Fb%20c/ship");
  });
});

describe("retry policy", () => {
  it("default reads retry a 503 and succeed", async () => {
    responses.push(json(503, {}), json(200, { carriers: [{ code: "X", label: "X" }] }));
    expect(await client().listCarriers()).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("default reads retry a network error", async () => {
    responses.push(networkError(), json(200, { carriers: [] }));
    await client().listCarriers();
    expect(calls).toHaveLength(2);
  });

  it("a refund is retried on 429 — Decathlon did nothing", async () => {
    responses.push(json(429, {}, { "Retry-After": "1" }), json(200, { refunds: [] }));
    await client().refundOrderLines([]);
    expect(calls).toHaveLength(2);
  });

  it("a refund is NOT resent after a 503", async () => {
    responses.push(json(503, {}), json(200, { refunds: [] }));
    await expect(client().refundOrderLines([])).rejects.toBeInstanceOf(DecathlonOutcomeUnknownError);
    expect(calls).toHaveLength(1);
  });

  it("a refund is NOT resent after a network error / timeout", async () => {
    responses.push(networkError(), json(200, { refunds: [] }));
    await expect(client().refundOrderLines([])).rejects.toBeInstanceOf(DecathlonOutcomeUnknownError);
    expect(calls).toHaveLength(1);
  });

  it("a shipment is NOT resent after a 502", async () => {
    responses.push(json(502, {}), json(201, {}));
    await expect(client().createShipments([])).rejects.toBeInstanceOf(DecathlonOutcomeUnknownError);
    expect(calls).toHaveLength(1);
  });

  it("a 400 is a plain API error carrying Decathlon's message, not 'outcome unknown'", async () => {
    responses.push(json(400, { message: "The currency ISO code is mandatory.", status: 400 }));
    const err = await client().refundOrderLines([]).catch((e) => e);
    expect(err).toBeInstanceOf(DecathlonApiError);
    expect(err).not.toBeInstanceOf(DecathlonOutcomeUnknownError);
    expect(err.message).toMatch(/currency ISO code is mandatory/);
    expect(calls).toHaveLength(1);
  });
});
