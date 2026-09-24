/**
 * Raw Decathlon (Mirakl) API response/request shapes.
 *
 * IMPORTANT: real field-level JSON schemas have NOT been provided yet (see docs/api-mapping.md §4).
 * Everything here is deliberately typed as loosely as possible (`unknown`/minimal known fields) so
 * the client compiles and is usable end-to-end, WITHOUT pretending to know field names that haven't
 * been confirmed. Tighten these types — and the Zod schemas in schemas.ts — the moment real request/
 * response examples are available. Do not add fields here from guesswork.
 */

/** Mirakl's documented offset-pagination convention — param names are the common Mirakl default,
 *  UNCONFIRMED for this specific Decathlon instance. */
export interface OffsetPaginationParams {
  offset?: number;
  max?: number;
}

/** Generic shape for Mirakl list endpoints: total_count + a data array under an endpoint-specific key.
 *  UNCONFIRMED exact key name per endpoint (e.g. "orders" vs "data") — callers should treat the
 *  response as `unknown` and extract defensively until confirmed. */
export interface RawPaginatedResponse {
  total_count?: number;
  [dataKey: string]: unknown;
}

export interface ImportResult {
  /** Always a string here even though Decathlon's raw JSON returns a NUMBER (confirmed live
   *  2026-09-15, OF24) — schemas.ts coerces it on parse so every caller sees a consistent type. */
  import_id?: string;
  [key: string]: unknown;
}

/**
 * Stage-2 (integration) counters of a product import — CONFIRMED live 2026-09-20. Only present once
 * Decathlon has actually tried to integrate the transformed rows into its catalog, which happens
 * AFTER `import_status` already reads COMPLETE; absence means "not integrated yet", not "nothing to
 * report". `products_successfully_synchronized` is the only counter that means a product is really
 * listed — everything else is a way of not being listed.
 */
export interface ImportIntegrationDetails {
  products_successfully_synchronized?: number;
  rejected_products?: number;
  invalid_products?: number;
  products_with_wrong_identifiers?: number;
  products_with_synchronization_issues?: number;
  products_not_accepted_in_time?: number;
  products_not_synchronized_in_time?: number;
}

export interface ImportStatusResult {
  import_id?: string;
  // CONFIRMED live 2026-09-15 (OF02, preprod): real in-progress value is "RUNNING", not "PENDING" as
  // originally guessed; terminal value seen was "COMPLETE". IMPORTANT: "COMPLETE" does NOT mean every
  // line succeeded — a real response came back `status: "COMPLETE"` with `lines_in_error: 1,
  // lines_in_success: 0` for a single-line batch that was entirely rejected. Callers MUST check
  // lines_in_error/lines_in_success (when present), not just `status`, to determine real success.
  status?: "RUNNING" | "COMPLETE" | "COMPLETE_WITH_ERRORS" | "FAILED" | string;
  // Fields below CONFIRMED live 2026-09-15 (OF02 / offer import response only).
  has_error_report?: boolean;
  lines_read?: number;
  lines_in_error?: number;
  lines_in_pending?: number;
  lines_in_success?: number;
  // CONFIRMED live 2026-09-18 (P42 / product import response): uses ENTIRELY DIFFERENT field names
  // from OF02 above, not just a differently-shaped subset — `status` is absent (use `import_status`
  // instead), and the line-count fields are `transform_`-prefixed. A caller that reads `.status`/
  // `.lines_in_error` on a P42 response gets `undefined` for both and silently treats every product
  // import as forever "PENDING" (confirmed live: this was shipped and caused every real product sync
  // to sit at SyncLog status PROCESSING indefinitely, retried every 60s, never resolving) — always
  // branch on the job's `kind` (packages/sync/src/engine.ts's pollImportStatus) rather than reading
  // these fields directly.
  import_status?: "RUNNING" | "COMPLETE" | "COMPLETE_WITH_ERRORS" | "FAILED" | string;
  has_new_product_report?: boolean;
  has_transformation_error_report?: boolean;
  has_transformed_file?: boolean;
  transform_lines_read?: number;
  transform_lines_in_error?: number;
  transform_lines_with_warning?: number;
  transform_lines_in_success?: number;
  /** Stage 2 — see ImportIntegrationDetails. Undefined until integration has actually run. */
  integration_details?: ImportIntegrationDetails;
  [key: string]: unknown;
}

/**
 * UNCONFIRMED — P41 request payload. No real Decathlon P41 request/response has ever been sent
 * (docs/api-mapping.md §4 item 6). Modeled on the standard Mirakl bulk-import convention: one flat
 * row per SKU, keyed by shop_sku, with PM11 attribute codes as additional keys. Do not trust this
 * shape until validated live (see the plan's "Live validation" step) — update this comment to
 * CONFIRMED <date> once it has been.
 */
export interface ProductImportRow {
  shop_sku: string;
  category_code: string;
  label: string;
  description?: string;
  ean?: string;
  brand?: string;
  images?: string[];
  /** PM11 attribute codes -> value, flattened onto the row per Mirakl's usual CSV-derived convention. */
  [attributeCode: string]: unknown;
}

export interface ProductImportRequest {
  products: ProductImportRow[];
}

/**
 * This app's single domain shape for an offer, expressed in OF24's JSON field names. OF01 (CSV)
 * uses DIFFERENT, hyphenated column names for the same data — `DecathlonClient.importOffers`
 * translates via toOfferCsvRow, so nothing upstream has to know which endpoint a batch will take.
 */
export interface OfferImportRow {
  shop_sku: string;
  price: number;
  quantity: number;
  /** OF24 only — OF01's CSV has no currency column (currency follows the sales channel). */
  currency_iso_code: string;
  /**
   * Offer condition, and MANDATORY on both endpoints: omitting it fails the import with "The state
   * of the product is unknown" (confirmed live 2026-09-20). This is the numeric CODE — `"11"` (New)
   * — not the label from Decathlon's published value list, which is rejected.
   */
  state_code?: string;
  /** Product reference that attaches this offer to a Decathlon catalogue product. */
  product_id?: string;
  product_id_type?: "EAN" | "SHOP_SKU" | "SKU";
  /** "update" (default) or "delete". */
  update_delete?: "update" | "delete";
  [key: string]: unknown;
}

export interface OfferImportRequest {
  offers: OfferImportRow[];
}

/**
 * OR11 order — CONFIRMED live 2026-09-21 (preprod, 500+ real orders). Only the fields this app reads
 * are typed. Note what is NOT here, because earlier code assumed it: there is no `id` (it is
 * `order_id`), no `order_state_code` (it is `order_state`), no `date_created` (it is `created_date`),
 * and no top-level addresses (they live under `customer.billing_address` / `customer.shipping_address`).
 */
export interface DecathlonOrderDto {
  order_id?: string;
  commercial_id?: string;
  order_state?: string;
  currency_iso_code?: string;
  created_date?: string;
  last_updated_date?: string;
  customer?: {
    customer_id?: string;
    firstname?: string;
    lastname?: string;
    billing_address?: unknown;
    shipping_address?: unknown;
    [key: string]: unknown;
  };
  customer_notification_email?: string;
  order_lines?: DecathlonOrderLineDto[];
  /** Order total incl. shipping. */
  total_price?: number;
  shipping_price?: number;
  shipping_carrier_code?: string | null;
  shipping_company?: string | null;
  shipping_tracking?: string | null;
  [key: string]: unknown;
}

/** CONFIRMED live 2026-09-21. `price` is the LINE total excluding shipping (qty 10 x price_unit 2 =
 *  price 20); `total_price` adds the line's shipping. */
export interface DecathlonOrderLineDto {
  order_line_id?: string;
  order_line_state?: string;
  offer_sku?: string;
  product_title?: string;
  quantity?: number;
  price?: number;
  price_unit?: number;
  shipping_price?: number;
  total_price?: number;
  can_refund?: boolean;
  refunds?: Array<{ id?: string; amount?: number; quantity?: number; shipping_amount?: number; state?: string; reason_code?: string }>;
  [key: string]: unknown;
}

export interface ShipmentTracking {
  /** A code from SH21. When the carrier isn't in that list, send carrier_name (+ url) instead —
   *  real orders on this instance carry free-text companies with a null code. */
  carrier_code?: string;
  carrier_name?: string;
  carrier_url?: string;
  tracking_number?: string;
  tracking_url?: string;
}

/** ST01 shipment. */
export interface ShipmentInput {
  order_id: string;
  shipped?: boolean;
  shipment_lines: Array<{ order_line_id: string; quantity: number }>;
  tracking?: ShipmentTracking;
}

export interface ShipmentBatchResult {
  shipment_errors?: Array<{ order_id?: string; id?: string; message?: string }>;
  shipment_success?: Array<{ id?: string; order_id?: string; [key: string]: unknown }>;
}

export interface DecathlonShipmentDto {
  id: string;
  order_id?: string;
  status?: string;
  shipment_lines?: Array<{ order_line_id?: string; offer_sku?: string; quantity?: number }>;
  tracking?: ShipmentTracking;
  [key: string]: unknown;
}

export interface DecathlonCarrier {
  code: string;
  label: string;
  tracking_url?: string;
  standard_code?: string;
}

/** OR28 refund line. `amount` is tax-included and excludes shipping, which goes in shipping_amount. */
export interface RefundInput {
  order_line_id: string;
  quantity: number;
  amount: number;
  shipping_amount?: number;
  currency_iso_code: string;
  reason_code: string;
}

/** OR28 response — CONFIRMED live 2026-09-21 (refund 6480). Each entry echoes the request plus
 *  `refund_id` (the same id that then appears as `refunds[].id` on the OR11 line) and
 *  `order_refund_id`. The refund starts in state WAITING_REFUND_PAYMENT on the line. */
export interface RefundBatchResult {
  order_tax_mode?: string;
  refunds?: Array<{ refund_id?: string; id?: string; order_refund_id?: string; order_line_id?: string; amount?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** RT11 return — CONFIRMED live 2026-09-15/21. */
export interface DecathlonReturnDto {
  id: string;
  order_id?: string;
  order_commercial_id?: string;
  state?: string;
  reason_code?: string;
  rma?: string | null;
  date_created?: string;
  last_updated?: string;
  return_lines?: Array<{ order_line_id?: string; quantity?: number; reason_code?: string }>;
  tracking?: ShipmentTracking & { carrier_standard_code?: string | null };
  [key: string]: unknown;
}

export interface ReturnBatchResult {
  return_errors?: Array<{ id?: string; message?: string }>;
  return_success?: Array<{ id?: string; [key: string]: unknown }>;
}
