import { DecathlonHttpClient, type DecathlonHttpClientOptions } from "./http-client";
import { ImportResultSchema, ImportStatusResultSchema, parseOrThrow, RawPaginatedResponseSchema } from "./schemas";
import type {
  DecathlonCarrier,
  DecathlonOrderDto,
  DecathlonReturnDto,
  DecathlonShipmentDto,
  RefundBatchResult,
  RefundInput,
  ReturnBatchResult,
  ShipmentBatchResult,
  ShipmentInput,
  ShipmentTracking,
  ImportResult,
  ImportStatusResult,
  OffsetPaginationParams,
  OfferImportRequest,
  OfferImportRow,
  ProductImportRequest,
  RawPaginatedResponse,
} from "./types";
import { rowsToCsv } from "./csv";

/**
 * OF24's JSON offer shape -> OF01's CSV columns. The two endpoints take the same data under
 * different names (confirmed live 2026-09-20 from OF01's own error report, which echoes the columns
 * it recognises); this app builds one domain row and translates here rather than making callers
 * care which endpoint a batch will end up on.
 */
function toOfferCsvRow(offer: OfferImportRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    sku: offer.shop_sku,
    price: offer.price,
    quantity: offer.quantity,
    state: offer.state_code,
    // Mirakl treats a row with no update-delete as an upsert, but saying so explicitly keeps the
    // file readable and leaves an obvious place to support deletion later.
    "update-delete": (offer.update_delete as string | undefined) ?? "update",
  };
  if (offer.product_id) {
    row["product-id"] = offer.product_id;
    row["product-id-type"] = offer.product_id_type ?? "EAN";
  }
  return row;
}

/**
 * Decathlon Partner (Mirakl Seller API) client.
 *
 * Every method maps 1:1 to a row in docs/api-mapping.md — see that doc for rate limits, which
 * source (generic Mirakl docs vs Decathlon's Zendesk guide) an endpoint came from, and what's still
 * unconfirmed. Do not add a method here for an endpoint that isn't in that mapping doc.
 */
export class DecathlonClient {
  private readonly http: DecathlonHttpClient;

  constructor(options: DecathlonHttpClientOptions) {
    this.http = new DecathlonHttpClient(options);
  }

  // ── Catalog reference data (H11 / PM11 / VL11) — cache these, max 1 call/hour per docs ──

  getHierarchies(): Promise<unknown> {
    return this.http.request("/api/hierarchies");
  }

  /**
   * CONFIRMED live 2026-09-18: `hierarchy_code` is accepted but silently ignored server-side — this
   * always returns the full ~38MB catalog-wide attribute list regardless of the value passed, so
   * callers must cache the whole response once and filter by `hierarchy_code` client-side (see
   * packages/decathlon/src/attributes.ts). The parameter is kept for when/if Decathlon adds real
   * filtering, not because it currently does anything.
   */
  getProductAttributes(hierarchyCode?: string): Promise<unknown> {
    return this.http.request("/api/products/attributes", { query: { hierarchy_code: hierarchyCode } });
  }

  /**
   * CONFIRMED live 2026-09-18: Decathlon's Zendesk-guide path (`/api/products/values`) 404s for this
   * one endpoint specifically — the generic Mirakl path below is the one that actually works here,
   * reversing this app's usual "Zendesk guide wins" rule (see docs/api-mapping.md §0).
   *
   * Unlike getProductAttributes, the `code` filter here IS honored server-side and matters a lot:
   * calling this with no code returns EVERY value list in Decathlon's entire catalog at once, which
   * is multiple **gigabytes** (confirmed live — a bare fetch blew past Node's ~4GB single-Buffer
   * limit). A single filtered list (e.g. `brandName`) is still tens of MB, but that's tractable to
   * cache; the unfiltered response never is. Always pass a code.
   */
  getValueLists(code: string): Promise<unknown> {
    return this.http.request("/api/values_lists", { query: { code } });
  }

  // ── Product creation (P41/P42/P44/P45/P31) — Shopify → Decathlon ──

  /**
   * CONFIRMED live 2026-09-15: a JSON body gets 415 Unsupported Media Type — Decathlon requires
   * multipart/form-data instead (Mirakl's usual bulk-import convention). CSV content, delimiter, and
   * the "file" form field name below are UNCONFIRMED — Decathlon's onboarder hasn't specified them
   * yet, so this is a best-effort default (see docs/api-mapping.md §4 item 7) pending real feedback
   * from a live import attempt.
   */
  async importProducts(payload: ProductImportRequest): Promise<ImportResult> {
    const csv = rowsToCsv(payload.products);
    const raw = await this.http.requestMultipart(
      "/api/products/imports",
      { fieldName: "file", filename: "products.csv", content: csv, contentType: "text/csv" },
      undefined,
      // CONFIRMED live 2026-09-18 — THE fix for the "1004|The category could not be identified"
      // error that every previous attempt hit regardless of category value or CSV formatting:
      // without this, Mirakl treats the file as a *shop-format* file and runs its "transformation"
      // step (shop columns → operator attributes) using a seller-configured mapping this account
      // doesn't have, so nothing — not even the category — could be identified. With it, the file is
      // read directly as operator attribute codes: has_transformed_file flipped to true, the status
      // advanced to SENT, and the report started returning real per-attribute validation instead.
      { operator_format: "true" },
    );
    return parseOrThrow(ImportResultSchema, raw, "P41 importProducts");
  }

  /**
   * CONFIRMED live 2026-09-20: a product import runs in TWO stages, and `import_status: "COMPLETE"`
   * only means the FIRST one finished. Stage 1 (transformation) reports via `transform_lines_*`;
   * stage 2 (integration into Decathlon's catalog — the stage that decides whether a product is
   * actually listed) reports via `integration_details`, which appears some time after the status
   * already reads COMPLETE. A real response had transform_lines_in_error: 0 / in_success: 4 while
   * integration_details said rejected_products: 4, products_successfully_synchronized: 0 — i.e.
   * judging success on the transform counts alone reports a total failure as a success.
   */
  async getProductImportStatus(importId: string): Promise<ImportStatusResult> {
    const raw = await this.http.request(`/api/products/imports/${encodeURIComponent(importId)}`);
    return parseOrThrow(ImportStatusResultSchema, raw, "P42 getProductImportStatus");
  }

  /**
   * The INTEGRATION-stage error report — the second of a product import's two stages (transformation
   * first, then integration into Decathlon's catalog; see getProductImportStatus's note). This is
   * where a row that transformed cleanly but was still refused explains itself, e.g.
   * `MCM-04020|The product has been deleted.`
   *
   * CONFIRMED live 2026-09-20: the path is **underscored** (`error_report`), like
   * transformation_error_report and unlike the hyphenated paths elsewhere in this client. The
   * hyphenated `error-report` guessed here previously 404s unconditionally, which is why this was
   * long believed to be "a report products never have" — it was the wrong URL, not missing data.
   */
  getProductImportErrorReport(importId: string): Promise<string> {
    return this.http.request(`/api/products/imports/${encodeURIComponent(importId)}/error_report`, {
      responseType: "text",
    });
  }

  /**
   * CONFIRMED live 2026-09-18: the real per-line P41 error report, keyed off `import_status`'s sibling
   * flag `has_transformation_error_report` (not `has_error_report`, see above). Note the path is
   * **underscored** (`transformation_error_report`), unlike every hyphenated path elsewhere in this
   * client — hyphenated guesses (`transformation-error-report`, `transform-error-report`) all 404.
   * Returns semicolon-delimited CSV echoing every submitted column plus a trailing `errors` column
   * with the real Mirakl error code/message (see docs/api-mapping.md §4 item 9).
   */
  getProductImportTransformationErrorReport(importId: string): Promise<string> {
    return this.http.request(`/api/products/imports/${encodeURIComponent(importId)}/transformation_error_report`, {
      responseType: "text",
    });
  }

  /** Returns raw text — Mirakl documents this as CSV, unconfirmed, see docs/api-mapping.md §4. */
  getProductImportSuccessReport(importId: string): Promise<string> {
    return this.http.request(`/api/products/imports/${encodeURIComponent(importId)}/report`, {
      responseType: "text",
    });
  }

  /** Max 100 refs per call per P31 docs. */
  getProducts(refs: string[]): Promise<unknown> {
    if (refs.length > 100) {
      throw new Error("P31 getProducts: max 100 product references per call (see docs/api-mapping.md)");
    }
    return this.http.request("/api/products", { query: { product_ids: refs.join(",") } });
  }

  // ── Offers — price & stock (OF61/OF01/OF02/OF03/OF24) — Shopify → Decathlon ──

  getOfferConditions(): Promise<unknown> {
    return this.http.request("/api/offers/conditions");
  }

  /**
   * Bulk offer import. Same 415/multipart requirement as importProducts, plus two things confirmed
   * live 2026-09-20 that made this endpoint unusable before:
   *
   *  1. **`import_mode` is a required form field** — without it OF01 returns
   *     `400 Param 'import_mode' is required` and nothing is imported at all. NORMAL is the mode
   *     Decathlon's own completed imports report back (`"mode":"NORMAL"` on OF02).
   *  2. **The CSV columns are OF01's hyphenated names, not OF24's JSON field names.** They are two
   *     different wire formats for the same data and only OF24 uses `shop_sku`/`state_code`; sending
   *     those as CSV headers means Decathlon recognises no column at all. There is no currency
   *     column in OF01 — currency follows the channel, so `currency_iso_code` is dropped here.
   *
   * `state` takes the numeric CODE (`11`), NOT the label from Decathlon's published value list:
   * submitting `11` and `New` as two rows of one file inserted the first and rejected the second
   * with "The state of the product is unknown".
   */
  async importOffers(payload: OfferImportRequest): Promise<ImportResult> {
    const csv = rowsToCsv(payload.offers.map((offer) => toOfferCsvRow(offer)));
    const raw = await this.http.requestMultipart(
      "/api/offers/imports",
      { fieldName: "file", filename: "offers.csv", content: csv, contentType: "text/csv" },
      undefined,
      { import_mode: "NORMAL" },
    );
    return parseOrThrow(ImportResultSchema, raw, "OF01 importOffers");
  }

  async getOfferImportStatus(importId: string): Promise<ImportStatusResult> {
    const raw = await this.http.request(`/api/offers/imports/${encodeURIComponent(importId)}`);
    return parseOrThrow(ImportStatusResultSchema, raw, "OF02 getOfferImportStatus");
  }

  /**
   * CONFIRMED live 2026-09-20: underscored, exactly like P44 — Decathlon's own documentation lists
   * this as `/error-report`, and that hyphenated path returns a bare 404 on this instance while
   * `/error_report` returns the real semicolon-delimited CSV. The long-standing belief that OF03 had
   * an "eventual consistency delay" was this same wrong URL: the report was always there.
   *
   * Columns end with `error-line` and `error-message`; the message is the useful one (see
   * parseReportText, which must not match `error-line` first and report a line number as the error).
   */
  getOfferImportErrorReport(importId: string): Promise<string> {
    return this.http.request(`/api/offers/imports/${encodeURIComponent(importId)}/error_report`, {
      responseType: "text",
    });
  }

  /**
   * Create/update/delete a small batch of offers — preferred for incremental stock/price pushes.
   * CONFIRMED 2026-09-15 (live, preprod): the body must be `{ offers: [...] }`, NOT a bare array as
   * originally assumed (a bare array gets a 400 "check the field datatype" from Decathlon) — also
   * confirmed to be async like OF01 (returns an import_id to poll via getOfferImportStatus), not the
   * synchronous call the docs' wording ("real-time") suggested.
   */
  upsertOffers(offers: unknown[]): Promise<ImportResult> {
    return this.http
      .request("/api/offers", { method: "POST", body: { offers } })
      .then((raw) => parseOrThrow(ImportResultSchema, raw, "OF24 upsertOffers"));
  }

  // ── Orders (OR11) — Decathlon → Shopify import ──
  //
  // Every order-scoped path below was CONFIRMED live 2026-09-21 against preprod. Decathlon's own
  // guide lists OR23 as `POST /api/orders/{id}/shipments` and OR28 as `POST /api/orders/{id}/refunds`;
  // both return a bare `{"message":"Not Found"}` on this instance (the wrong-URL signature, see
  // docs/api-mapping.md §4 item 11), while the generic Mirakl paths used here answer with real
  // business validation. Same situation as VL11 — live behaviour beats either document.

  /**
   * Only fetches orders awaiting shipment, per Decathlon's guide: orders are auto-accepted (payment
   * captured before order creation), so this app's job starts at SHIPPING status. The filter is on
   * the ORDER state (`order_state`); REFUNDED/CLOSED also appear as order-LINE states.
   */
  async listOrdersAwaitingShipment(pagination: OffsetPaginationParams = {}): Promise<RawPaginatedResponse> {
    const raw = await this.http.request("/api/orders", {
      query: { order_state_codes: "SHIPPING", offset: pagination.offset, max: pagination.max },
    });
    return parseOrThrow(RawPaginatedResponseSchema, raw, "OR11 listOrdersAwaitingShipment");
  }

  /** OR11 filtered to specific `order_id`s (comma-separated, confirmed live) — the current state of
   *  an order this app already imported, e.g. to see what is still refundable. */
  async getOrders(orderIds: string[]): Promise<DecathlonOrderDto[]> {
    const raw = (await this.http.request("/api/orders", {
      query: { order_ids: orderIds.join(","), max: Math.max(orderIds.length, 1) },
    })) as { orders?: DecathlonOrderDto[] };
    return raw.orders ?? [];
  }

  // ── Shipments (ST01/ST11/ST23, OR23/OR24) — Shopify → Decathlon ──

  /**
   * ST01 — create shipments, optionally partial (per order line and quantity) with tracking inline.
   * This instance runs Mirakl's multi-shipment model: every historical order has ST11 shipment
   * records with their own ids, which is what the guide's `{order_id}/shipments/{shipment_id}` wording
   * describes. One Shopify fulfillment maps onto one of these.
   *
   * CONFIRMED live: `{shipments:[...]}` wrapper, 1–1000 entries. Answers **201 even when every
   * shipment failed** — the outcome is in `shipment_errors[]` / `shipment_success[]`, so a 2xx alone
   * means nothing. A shipment is refused unless its order is in state SHIPPING. UNCONFIRMED (no
   * SHIPPING order has existed on preprod to test with): the exact fields of a `shipment_success`
   * entry, and whether `shipped: true` is required for the order to advance to SHIPPED — unknown
   * fields are ignored rather than rejected, so it is sent explicitly.
   */
  createShipments(shipments: ShipmentInput[]): Promise<ShipmentBatchResult> {
    return this.http.request("/api/shipments", { method: "POST", body: { shipments }, retryPolicy: "rate-limit-only" });
  }

  /** ST11 — shipments of one order (confirmed live: `{data:[{id, status, shipment_lines, tracking}]}`). */
  async listShipments(orderId: string): Promise<DecathlonShipmentDto[]> {
    const raw = (await this.http.request("/api/shipments", { query: { order_id: orderId } })) as {
      data?: DecathlonShipmentDto[];
    };
    return raw.data ?? [];
  }

  /**
   * ST23 — update tracking on existing shipments. CONFIRMED live: **POST** (PUT is 405), body
   * `{shipments:[{id, tracking}]}`, 200 with per-shipment `shipment_errors`/`shipment_success`.
   */
  updateShipmentTracking(updates: Array<{ id: string; tracking: ShipmentTracking }>): Promise<ShipmentBatchResult> {
    return this.http.request("/api/shipments/tracking", { method: "POST", body: { shipments: updates } });
  }

  /** OR23 — whole-order tracking. CONFIRMED live: `PUT /api/orders/{id}/tracking`, validates carrier_code. */
  updateOrderTracking(orderId: string, tracking: ShipmentTracking): Promise<void> {
    return this.http.request(`/api/orders/${encodeURIComponent(orderId)}/tracking`, { method: "PUT", body: tracking });
  }

  /** OR24 — mark the whole order shipped. CONFIRMED live: `PUT /api/orders/{id}/ship`, no body,
   *  400 unless the order is in SHIPPING. */
  markOrderShipped(orderId: string): Promise<void> {
    return this.http.request(`/api/orders/${encodeURIComponent(orderId)}/ship`, { method: "PUT", emptyBody: true });
  }

  /** SH21 — carriers configured by the operator (`{carriers:[{code, label, tracking_url}]}`, confirmed
   *  live). Not in Decathlon's guide, but it is the only source of valid `carrier_code` values. */
  async listCarriers(): Promise<DecathlonCarrier[]> {
    const raw = (await this.http.request("/api/shipping/carriers")) as { carriers?: DecathlonCarrier[] };
    return raw.carriers ?? [];
  }

  // ── Refunds (OR28) — Shopify → Decathlon ──

  /**
   * OR28 — used for ALL post-payment cancellation/return/price-adjustment cases per Decathlon's
   * guide. CONFIRMED live: `PUT /api/orders/refund`, body `{refunds:[...]}`, and the validation it
   * applies — `currency_iso_code` is mandatory, `amount` must exceed 0.01 and stay below what is left
   * to refund on the line, and the line must be SHIPPING/SHIPPED/TO_COLLECT/RECEIVED/INCIDENT_OPEN.
   * Amounts are tax-included (the response echoes `order_tax_mode: "TAX_INCLUDED"`).
   */
  refundOrderLines(refunds: RefundInput[]): Promise<RefundBatchResult> {
    return this.http.request("/api/orders/refund", { method: "PUT", body: { refunds }, retryPolicy: "rate-limit-only" });
  }

  /** RE01 — reasons of one type, e.g. REFUND (`{reasons:[{code, label}]}`, confirmed live). */
  async listReasons(type: "REFUND" | string): Promise<Array<{ code: string; label: string }>> {
    const raw = (await this.http.request(`/api/reasons/${encodeURIComponent(type)}`)) as {
      reasons?: Array<{ code: string; label: string }>;
    };
    return raw.reasons ?? [];
  }

  // ── Accounting documents (DR11/DR74) ──

  listDocumentRequests(pagination: { limit?: number; page_token?: string } = {}): Promise<unknown> {
    return this.http.request("/api/document-request/requests", { query: { ...pagination } });
  }

  /**
   * DR74 — CONFIRMED live: a JSON body gets 415, so this is a multipart upload like P41/OF01. The
   * form field names are UNCONFIRMED; nothing calls this yet because Shopify has no invoice PDF to
   * send (see docs/api-mapping.md §4 item 13).
   */
  uploadAccountingDocument(file: { filename: string; content: string; contentType: string }, fields: Record<string, string>): Promise<unknown> {
    return this.http.requestMultipart(
      "/api/document-request/documents/upload",
      { fieldName: "files", ...file },
      undefined,
      fields,
    );
  }

  // ── Returns (RT30/RT31/RT12/RT01/RT11/RT04/RT29) ──
  //
  // CONFIRMED live 2026-09-21: RT11/RT12 use seek pagination (`limit` + `page_token`, envelope
  // `{data, next_page_token}`), and every write takes a `{returns:[...]}` wrapper and answers 200
  // with per-return `return_errors`/`return_success`. RT30/RT31 are 403 for this seller's key.

  getOperatorReturnConfig(): Promise<unknown> {
    return this.http.request("/api/returns/operator_configuration");
  }

  getShopReturnConfig(): Promise<unknown> {
    return this.http.request("/api/returns/shop_configuration");
  }

  /** RT12 — 400 without a filter; `order_commercial_id` or `order_line_id` is required. */
  getItemsToReturn(filter: { order_commercial_id?: string; order_line_id?: string }): Promise<unknown> {
    return this.http.request("/api/returns/items_to_return", { query: filter });
  }

  createReturns(returns: unknown[]): Promise<ReturnBatchResult> {
    return this.http.request("/api/returns", { method: "POST", body: { returns } });
  }

  /** RT11. Only `sort=date_created,<ASC|DESC>` is accepted; unknown filters are silently ignored,
   *  but `order_commercial_id` genuinely filters. */
  async listReturns(
    params: { limit?: number; page_token?: string; order_commercial_id?: string; sort?: string } = {},
  ): Promise<{ data: DecathlonReturnDto[]; next_page_token?: string | null }> {
    const raw = (await this.http.request("/api/returns", { query: { ...params } })) as {
      data?: DecathlonReturnDto[];
      next_page_token?: string | null;
    };
    return { data: raw.data ?? [], next_page_token: raw.next_page_token };
  }

  /** RT04 — e.g. `{id, rma}` or tracking/label updates. */
  updateReturns(returns: Array<{ id: string; [field: string]: unknown }>): Promise<ReturnBatchResult> {
    return this.http.request("/api/returns", { method: "PUT", body: { returns } });
  }

  /** RT29 — CONFIRMED live: **PUT** (POST is 405), body `{returns:[{id}]}`. */
  cancelReturns(returnIds: string[]): Promise<ReturnBatchResult> {
    return this.http.request("/api/returns/cancel", { method: "PUT", body: { returns: returnIds.map((id) => ({ id })) } });
  }

  /**
   * Lightweight connection test for the "Test Connection" UI (requirement §28) — uses the cheapest
   * confirmed read endpoint (H11) rather than a dedicated healthcheck endpoint, since none is
   * documented.
   */
  async testConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.getHierarchies();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
