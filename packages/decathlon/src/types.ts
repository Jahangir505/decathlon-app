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
 * UNCONFIRMED — OR11 order shape. No real order has ever been fetched (docs/api-mapping.md §4 item 6
 * — write endpoints untested, and no test order exists in preprod yet either). Modeled defensively:
 * only `id`/`order_state_code` are assumed present, everything else is optional/unknown so parsing
 * degrades gracefully rather than throwing on a real (differently-shaped) response.
 */
export interface DecathlonOrderDto {
  id?: string;
  commercial_id?: string;
  order_state_code?: string;
  currency_iso_code?: string;
  date_created?: string;
  customer?: unknown;
  shipping_address?: unknown;
  billing_address?: unknown;
  order_lines?: unknown[];
  total_price?: number;
  shipping_price?: number;
  [key: string]: unknown;
}

/**
 * UNCONFIRMED — OR11 list envelope. Modeled on DR11/RT11's CONFIRMED-live envelope shape
 * (`{ data: [...], next_page_token }`, see docs/api-mapping.md §5) since those are the only two
 * list endpoints actually exercised against a real Decathlon response so far — OR11 likely follows
 * the same Mirakl-instance convention, but this has NOT been confirmed.
 */
export interface OrdersListResponse {
  data?: DecathlonOrderDto[];
  orders?: DecathlonOrderDto[]; // fallback key name, in case OR11 differs from DR11/RT11's envelope
  total_count?: number;
  next_page_token?: string;
  [key: string]: unknown;
}
