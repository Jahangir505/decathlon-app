import { createHash, randomUUID } from "node:crypto";
import type { Repositories, SyncConfiguration, SyncJobType } from "@shopify-decathlon/database";
import type { DecathlonAttribute, DecathlonClient, ProductImportRequest } from "@shopify-decathlon/decathlon";
import { ancestorCodesFor, requiredAttributesForCategory } from "@shopify-decathlon/decathlon";
import type { ShopifyAdminGraphqlClient } from "@shopify-decathlon/shopify";
import {
  ORDER_CREATE_MUTATION,
  PRODUCT_WITH_VARIANTS_QUERY,
  SHOP_INFO_QUERY,
  VARIANTS_TO_PRODUCTS_QUERY,
  type OrderCreateResponse,
  type ProductWithVariantsResponse,
  type ShopInfoResponse,
  type VariantsToProductsResponse,
} from "@shopify-decathlon/shopify";
import type { Logger } from "@shopify-decathlon/logger";
import { maskSecrets } from "@shopify-decathlon/logger";
import type { NormalizedProduct, NormalizedVariant } from "@shopify-decathlon/shared";
import { ValidationError } from "@shopify-decathlon/shared";
import type {
  FulfillmentSyncJobPayload,
  ImportStatusPollJobPayload,
  OfferSyncJobPayload,
  OrderImportJobPayload,
  ProductSyncJobPayload,
  RefundSyncJobPayload,
  ReturnSyncJobPayload,
} from "./queues";
import { OrderLifecycleSync } from "./order-lifecycle";
import { MAX_IMPORT_POLL_ATTEMPTS } from "./queues";
import { CatalogCache } from "./catalog-cache";
import { matchOrderLine, matchProductMapping } from "./matching";
import { normalizeShopifyProduct, buildShopifyOrderInput } from "./adapters/shopify.adapter";
import {
  buildProductImportPayload,
  buildOfferImportPayload,
  extractOrdersArray,
  normalizeDecathlonOrder,
  parseReportText,
  optionRoleNames,
  BRAND_ATTRIBUTE_CODE,
  SIZE_ATTRIBUTE_CODE,
  SIZE_VALUE_LISTS,
  type ParsedReportRow,
} from "./adapters/decathlon.adapter";

export interface SyncEngineDeps {
  repositories: Repositories;
  decathlon: DecathlonClient;
  shopify: ShopifyAdminGraphqlClient;
  logger: Logger;
}

/** Result of a successful product/offer import submission — tells the caller (worker) to chain an
 *  IMPORT_STATUS_POLL job. Null means nothing was submitted (skipped, or a synchronous OF24 push). */
export interface ImportSubmission {
  importId: string;
  kind: "product" | "offer";
  shopifyVariantIds: string[];
  correlationId: string;
  syncJobId: string;
  /** Carried into the poll job so the terminal SyncLog can name the product it was about. */
  itemLabel: string;
}

/**
 * An automatic sync found nothing Decathlon would see as changed, so no import was made. The
 * variants in `liveVariantIds` are already listed on Decathlon; the caller pushes their price and
 * stock (OF24) instead, since a Shopify price change arrives as the same products/update webhook.
 */
export interface ProductUnchanged {
  unchanged: true;
  liveVariantIds: string[];
  correlationId: string;
}

export type ProductSyncResult = ImportSubmission | ProductUnchanged | null;

/** Why a category code can't hold products, or undefined when it can. Exported for the Mappings API. */
export function categoryError(hierarchies: Array<{ code: string; label: string; parentCode: string }>, code: string): string | undefined {
  const node = hierarchies.find((h) => h.code === code);
  if (!node) return `Decathlon category "${code}" doesn't exist.`;
  if (hierarchies.some((h) => h.parentCode === code)) {
    return `Decathlon category ${code} "${node.label}" is a group of categories, not a category products can be listed in.`;
  }
  return undefined;
}

type ProductMappingRow = NonNullable<Awaited<ReturnType<typeof matchProductMapping>>["mapping"]>;

/** Outcome of SyncEngine.prepareProductImport. */
export type PreparedProduct =
  | { kind: "inactive"; product: NormalizedProduct; itemLabel: string; message: string }
  | { kind: "no-variants"; product: NormalizedProduct; itemLabel: string }
  | { kind: "invalid"; product?: NormalizedProduct; itemLabel?: string; error: Error }
  | {
      kind: "ready";
      product: NormalizedProduct;
      variants: NormalizedVariant[];
      itemLabel: string;
      requestPayload: ProductImportRequest;
      mappingByVariantId: Map<string, ProductMappingRow>;
      existingDecathlonProductIdByVariantId: Map<string, string>;
    };

/** One product on the Mappings page's readiness check. */
export interface ProductReadiness {
  shopifyProductId: string;
  title: string;
  status: "ready" | "blocked" | "skipped";
  variants: number;
  /** Each thing to fix, in the merchant's terms. */
  problems: string[];
}

/** The builder reports every missing attribute in one message ("...attributes: a; b; c") — split
 *  it so the readiness check can list them one per line. */
function splitProblems(message: string): string[] {
  const marker = "is missing required Decathlon attributes: ";
  const at = message.indexOf(marker);
  return at === -1 ? [message] : message.slice(at + marker.length).split("; ").map((p) => p.trim()).filter(Boolean);
}

/** Order-independent fingerprint of one P41 row — what "unchanged" means for a variant. */
export function hashImportRow(row: Record<string, unknown>): string {
  const stable = Object.keys(row)
    .sort()
    .map((k) => [k, row[k]]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export type PollOutcome =
  | { status: "PENDING" }
  | { status: "TERMINAL"; result: "SUCCESS" | "FAILED"; kind: "product" | "offer"; shopId: string; shopifyVariantIds: string[]; correlationId: string };

/** "Title — SKU-A, SKU-B (+3 more)" — what the Sync Logs UI shows so a row identifies its product. */
function describeProduct(title: string, skus: string[]): string {
  const shown = skus.slice(0, 3).join(", ");
  const rest = skus.length > 3 ? ` (+${skus.length - 3} more)` : "";
  return skus.length > 0 ? `${title} — ${shown}${rest}` : title;
}

/**
 * Orchestrates the data flows documented in docs/architecture.md §5-7.
 *   - syncProduct / syncOffers / pollImportStatus  → Phase 4/5 (implemented)
 *   - importOrders                                  → Phase 6 (implemented)
 *   - syncFulfillment / syncRefund / syncReturns    → Phase 7 (implemented in order-lifecycle.ts)
 *
 * Every Decathlon request/response shape used here for P41/OF01/OF24/OR11 is UNCONFIRMED pending
 * live validation against the preprod sandbox (see the project plan's "Live validation" step) —
 * see packages/decathlon/src/types.ts for the per-field caveats.
 */
export class SyncEngine {
  private readonly catalog: CatalogCache;
  private readonly lifecycle: OrderLifecycleSync;

  constructor(private readonly deps: SyncEngineDeps) {
    this.catalog = new CatalogCache(deps.repositories, deps.decathlon, deps.logger);
    this.lifecycle = new OrderLifecycleSync(deps);
  }

  // ── Product sync (Phase 4) ──────────────────────────────────────────────────────────────────

  async syncProduct(payload: ProductSyncJobPayload): Promise<ProductSyncResult> {
    const { repositories, decathlon, shopify, logger } = this.deps;
    const shopId = payload.shopId;
    const correlationId = payload.correlationId ?? randomUUID();
    const syncJobId = await this.ensureSyncJob(shopId, "PRODUCT_SYNC", payload, payload.syncJobId);

    let prepared: PreparedProduct;
    try {
      prepared = await this.prepareProductImport(shopId, payload.shopifyProductId, { variantIds: payload.shopifyVariantIds });
    } catch (err) {
      await this.failJob(shopId, syncJobId, "PRODUCT_SYNC", correlationId, err);
      throw err; // transport-level failure — let BullMQ's job-level retry apply
    }

    if (prepared.kind === "inactive") {
      await repositories.syncLogs.write({
        shopId,
        syncJobId,
        type: "PRODUCT_SYNC",
        status: "SKIPPED",
        correlationId,
        itemLabel: prepared.itemLabel,
        shopifyId: payload.shopifyProductId,
        errorMessage: prepared.message,
      });
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", prepared.message);
      return null;
    }
    if (prepared.kind === "no-variants") {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "No matching variants to sync");
      return null;
    }
    if (prepared.kind === "invalid") {
      // Deterministic (missing category, metafield, attribute...) — retrying won't fix it without
      // merchant action, so the job fails cleanly instead of burning BullMQ retries.
      await this.failJob(shopId, syncJobId, "PRODUCT_SYNC", correlationId, prepared.error, prepared.itemLabel);
      return null;
    }
    const { product, variants, mappingByVariantId, existingDecathlonProductIdByVariantId } = prepared;
    let { requestPayload } = prepared;

    // Skip what Decathlon already has. Rows are keyed by shop_sku = variant SKU (see the builder).
    const variantBySku = new Map(variants.map((v) => [v.sku, v]));
    const hashBySku = new Map(requestPayload.products.map((row) => [row.shop_sku, hashImportRow(row)]));
    if (payload.trigger === "webhook") {
      const changed = requestPayload.products.filter((row) => {
        const mapping = mappingByVariantId.get(variantBySku.get(row.shop_sku)?.shopifyVariantId ?? "");
        return mapping?.lastPayloadHash !== hashBySku.get(row.shop_sku);
      });
      if (changed.length === 0) {
        const liveVariantIds = variants
          .filter((v) => mappingByVariantId.get(v.shopifyVariantId!)?.decathlonProductId)
          .map((v) => v.shopifyVariantId!);
        await repositories.syncJobs.finish(syncJobId, "SKIPPED", "Nothing Decathlon uses changed since the last import");
        logger.info({ event: "product_sync_unchanged", shopId, productId: payload.shopifyProductId, liveVariants: liveVariantIds.length });
        return { unchanged: true, liveVariantIds, correlationId };
      }
      requestPayload = { ...requestPayload, products: changed };
    }
    const submitted = variants.filter((v) => requestPayload.products.some((row) => row.shop_sku === v.sku));

    let result;
    try {
      result = await decathlon.importProducts(requestPayload);
    } catch (err) {
      await this.failJob(shopId, syncJobId, "PRODUCT_SYNC", correlationId, err);
      throw err;
    }

    if (!result.import_id) {
      await this.failJob(shopId, syncJobId, "PRODUCT_SYNC", correlationId, new Error("P41 response missing import_id"));
      return null;
    }

    for (const variant of submitted) {
      await repositories.productMappings.upsertForVariant(shopId, payload.shopifyProductId, variant.shopifyVariantId!, {
        sku: variant.sku,
        ean: variant.ean,
        shopSku: variant.sku,
        decathlonProductId: existingDecathlonProductIdByVariantId.get(variant.shopifyVariantId!),
        lastPayloadHash: hashBySku.get(variant.sku),
      });
    }

    const itemLabel = describeProduct(product.title, submitted.map((v) => v.sku));

    await repositories.syncLogs.write({
      shopId,
      syncJobId,
      type: "PRODUCT_SYNC",
      status: "PROCESSING",
      correlationId,
      itemLabel,
      shopifyId: payload.shopifyProductId,
      requestSummary: maskSecrets(requestPayload) as object,
      responseSummary: maskSecrets(result) as object,
    });
    await repositories.syncJobs.updateProgress(syncJobId, submitted.length, submitted.length);
    logger.info({ event: "product_sync_submitted", shopId, importId: result.import_id, variantCount: submitted.length });

    return {
      importId: result.import_id,
      kind: "product",
      shopifyVariantIds: submitted.map((v) => v.shopifyVariantId!),
      correlationId,
      syncJobId,
      itemLabel,
    };
  }

  /**
   * Everything an import needs, short of sending it: fetch the Shopify product, check it is active,
   * resolve its category (and refuse a category group), load Decathlon's attribute/value lists and
   * the shop's mappings, and build the P41 rows. Shared by syncProduct and checkProduct, so the
   * Mappings page's readiness check reports exactly what an import would refuse.
   * Throws only on transport failures (Shopify unreachable); every data problem is a result.
   */
  async prepareProductImport(
    shopId: string,
    shopifyProductId: string,
    opts: { variantIds?: string[]; skipDuplicateCheck?: boolean } = {},
  ): Promise<PreparedProduct> {
    const { repositories, shopify } = this.deps;
    const config = await repositories.syncConfigurations.getOrCreateDefault(shopId);
    const raw = await shopify.request<ProductWithVariantsResponse>(PRODUCT_WITH_VARIANTS_QUERY, { id: shopifyProductId });

    let product: NormalizedProduct;
    try {
      product = normalizeShopifyProduct(raw, config.defaultCurrency);
    } catch (err) {
      return { kind: "invalid", error: err instanceof Error ? err : new Error(String(err)) };
    }
    const itemLabel = describeProduct(product.title, product.variants.map((v) => v.sku));

    // Only ACTIVE products are listed on Decathlon. The webhook and the bulk scan already filter on
    // this; reaching here with a draft/archived product means its status changed after queueing.
    // Checked before the category so an unfinished draft is "skipped", not a failure to fix.
    if (product.status !== "ACTIVE") {
      return {
        kind: "inactive",
        product,
        itemLabel,
        message: `"${product.title}" is ${(product.status ?? "not active").toLowerCase()} in Shopify — only active products are imported to Decathlon`,
      };
    }

    const typeRule = product.productType ? await repositories.categoryMappings.findByProductType(shopId, product.productType) : null;
    try {
      product.categoryCode = await this.resolveCategoryCode(shopId, product);
    } catch (err) {
      return { kind: "invalid", product, itemLabel, error: err instanceof Error ? err : new Error(String(err)) };
    }

    const variants = opts.variantIds
      ? product.variants.filter((v) => v.shopifyVariantId && opts.variantIds!.includes(v.shopifyVariantId))
      : product.variants;
    if (variants.length === 0) return { kind: "no-variants", product, itemLabel };

    // PM11 ignores its filter param and always returns the full catalog-wide attribute list
    // (confirmed live 2026-09-18) — one cache entry per shop. H11 is needed alongside it because
    // required attributes are inherited from ancestor categories (see requiredAttributesForCategory).
    const [attributes, hierarchies] = await Promise.all([this.catalog.attributes(shopId), this.catalog.hierarchies(shopId)]);
    const ancestorCodes = ancestorCodesFor(hierarchies, product.categoryCode);

    // Products can only be listed in a specific (leaf) category. A group such as 100000 "Apparel,
    // Footwear, Accessories" imports without complaint and is simply never publishable.
    const categoryProblem = categoryError(hierarchies, product.categoryCode);
    if (categoryProblem) {
      return {
        kind: "invalid",
        product,
        itemLabel,
        error: new ValidationError(
          `"${product.title}": ${categoryProblem} Pick a specific category on the Mappings page, or in the product's "Decathlon Category" metafield.`,
        ),
      };
    }

    // Unlike PM11, VL11's `code` filter is real and matters: an unfiltered call returns every value
    // list in the catalog (multiple GB). Only the lists actually referenced are fetched and cached:
    // the category's required LIST attributes, metafield overrides, and — when this product type has
    // a size chart — Decathlon's size lists.
    const requiredForCategory = requiredAttributesForCategory(attributes, product.categoryCode, ancestorCodes);
    const overriddenAttributes = Object.keys(product.attributes ?? {})
      .map((code) => attributes.find((a) => a.code === code))
      .filter((a): a is DecathlonAttribute => Boolean(a));
    const neededListCodes = [
      ...new Set(
        [...requiredForCategory, ...overriddenAttributes]
          .map((a) => a.valuesList)
          .filter((c): c is string => Boolean(c))
          .concat(typeRule?.sizeChart ? SIZE_VALUE_LISTS : []),
      ),
    ];
    const valueLists = (await Promise.all(neededListCodes.map((code) => this.catalog.valueList(shopId, code)))).flat();

    // Duplicate-prevention pass (docs/sync-strategy.md §1 step 2): for any variant with no local
    // mapping yet, check whether Decathlon already lists this shop_sku, so the mapping written after
    // submission points at the REAL existing product from the start.
    const existingDecathlonProductIdByVariantId = new Map<string, string>();
    const mappingByVariantId = new Map<string, NonNullable<Awaited<ReturnType<typeof matchProductMapping>>["mapping"]>>();
    for (const variant of variants) {
      if (opts.skipDuplicateCheck) {
        const mapping = await repositories.productMappings.findByVariant(shopId, variant.shopifyVariantId!);
        if (mapping) mappingByVariantId.set(variant.shopifyVariantId!, mapping);
        continue;
      }
      const match = await matchProductMapping(this.deps, shopId, { shopifyVariantId: variant.shopifyVariantId!, shopSku: variant.sku });
      if (match.mapping) mappingByVariantId.set(variant.shopifyVariantId!, match.mapping);
      if (match.existingDecathlonProductId) {
        existingDecathlonProductIdByVariantId.set(variant.shopifyVariantId!, match.existingDecathlonProductId);
      }
    }

    // The merchant's explicit decisions for every LIST attribute in play, plus brand and size, which
    // are stored as value mappings too — the builder prefers them over any name matching.
    const listAttributeCodes = [
      ...new Set([...requiredForCategory, ...overriddenAttributes].map((a) => a.code).concat(BRAND_ATTRIBUTE_CODE, SIZE_ATTRIBUTE_CODE)),
    ];
    const valueMappings = await repositories.attributeValueMappings.mapFor(shopId, listAttributeCodes);

    try {
      const requestPayload = buildProductImportPayload(
        variants.map((variant) => ({ product, variant })),
        {
          attributes,
          valueLists,
          ancestorCodes,
          manufacturerEmail: config.manufacturerEmail,
          fallbackBrandName: config.fallbackBrandName,
          ...optionRoleNames(config),
          valueMappings,
          typeRule: typeRule
            ? { productType: product.productType ?? typeRule.shopifyProductType, gender: typeRule.gender, sizeChart: typeRule.sizeChart }
            : undefined,
        },
      );
      return { kind: "ready", product, variants, itemLabel, requestPayload, mappingByVariantId, existingDecathlonProductIdByVariantId };
    } catch (err) {
      return {
        kind: "invalid",
        product,
        itemLabel: describeProduct(product.title, variants.map((v) => v.sku)),
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /** Dry run of an import for the Mappings page: what would happen, without sending anything. */
  async checkProduct(shopId: string, shopifyProductId: string): Promise<ProductReadiness> {
    const prepared = await this.prepareProductImport(shopId, shopifyProductId, { skipDuplicateCheck: true });
    const title = prepared.product?.title ?? shopifyProductId;
    if (prepared.kind === "ready") {
      return { shopifyProductId, title, status: "ready", variants: prepared.variants.length, problems: [] };
    }
    if (prepared.kind === "inactive" || prepared.kind === "no-variants") {
      return { shopifyProductId, title, status: "skipped", variants: 0, problems: prepared.kind === "inactive" ? [prepared.message] : [] };
    }
    return {
      shopifyProductId,
      title,
      status: "blocked",
      variants: prepared.product?.variants.length ?? 0,
      problems: splitProblems(prepared.error.message),
    };
  }

  // ── Offer sync (Phase 5) ────────────────────────────────────────────────────────────────────

  async syncOffers(payload: OfferSyncJobPayload): Promise<ImportSubmission | null> {
    const { repositories, decathlon, shopify, logger } = this.deps;
    const shopId = payload.shopId;
    const correlationId = payload.correlationId ?? randomUUID();
    const syncJobId = await this.ensureSyncJob(shopId, "OFFER_SYNC", payload, payload.syncJobId);
    const config = await repositories.syncConfigurations.getOrCreateDefault(shopId);

    const mappings = await Promise.all(
      payload.shopifyVariantIds.map((id) => repositories.productMappings.findByVariant(shopId, id)),
    );
    const eligible = mappings.filter((m): m is NonNullable<typeof m> => Boolean(m?.decathlonProductId));

    if (eligible.length === 0) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "No variant has been product-synced to Decathlon yet");
      return null;
    }

    const productIds = await this.resolveProductIds(shopify, eligible.map((m) => m.shopifyVariantId));
    const variantsBySku = await this.fetchFreshVariants(shopify, [...new Set(productIds.values())], config, logger, shopId);

    const variants: NormalizedVariant[] = [];
    for (const mapping of eligible) {
      const v = variantsBySku.get(mapping.shopifyVariantId);
      if (v) variants.push(v);
    }

    if (variants.length === 0) {
      await repositories.syncJobs.finish(syncJobId, "FAILED", "Could not re-fetch fresh price/stock for any eligible variant");
      return null;
    }

    const allHaveOfferId = eligible.every((m) => m.decathlonOfferId);
    const useRealtimeUpsert = allHaveOfferId && variants.length <= 50;
    const requestPayload = buildOfferImportPayload(variants, {
      priceMarkupPercent: config.priceMarkupPercent ? Number(config.priceMarkupPercent) : null,
      priceDiscountPercent: config.priceDiscountPercent ? Number(config.priceDiscountPercent) : null,
      defaultCurrency: config.defaultCurrency,
      offerStateCode: config.offerStateCode,
    });

    // Both OF24 (small/incremental) and OF01 (bulk) are async and return an import_id to poll —
    // CONFIRMED live 2026-09-15: OF24 is NOT synchronous despite docs/api-mapping.md describing it
    // as "real-time" (see packages/decathlon/src/client.ts's upsertOffers comment). The choice below
    // is purely about which endpoint is more appropriate for the batch size, per Decathlon's own
    // usage guidance — both now go through the same submit-then-poll path.
    let result;
    try {
      result = useRealtimeUpsert ? await decathlon.upsertOffers(requestPayload.offers) : await decathlon.importOffers(requestPayload);
    } catch (err) {
      for (const mapping of eligible) {
        await repositories.productMappings.markFailed(shopId, mapping.shopifyVariantId, err instanceof Error ? err.message : String(err));
      }
      await this.failJob(shopId, syncJobId, "OFFER_SYNC", correlationId, err);
      throw err;
    }

    if (!result.import_id) {
      await this.failJob(shopId, syncJobId, "OFFER_SYNC", correlationId, new Error("Offer import response missing import_id"));
      return null;
    }

    const itemLabel = describeProduct("Price & stock", variants.map((v) => v.sku));

    await repositories.syncLogs.write({
      shopId,
      syncJobId,
      type: "OFFER_SYNC",
      status: "PROCESSING",
      correlationId,
      itemLabel,
      requestSummary: maskSecrets(requestPayload) as object,
      responseSummary: maskSecrets(result) as object,
    });
    await repositories.syncJobs.updateProgress(syncJobId, variants.length, variants.length);

    return {
      importId: result.import_id,
      kind: "offer",
      shopifyVariantIds: eligible.map((m) => m.shopifyVariantId),
      correlationId,
      syncJobId,
      itemLabel,
    };
  }

  // ── Import status polling (P42/OF02 — fills the gap left by the original Phase 2 scaffold) ────

  async pollImportStatus(payload: ImportStatusPollJobPayload): Promise<PollOutcome> {
    const { repositories, decathlon, logger } = this.deps;
    const shopId = payload.shopId;
    const correlationId = payload.correlationId ?? randomUUID();

    const statusResult =
      payload.kind === "product"
        ? await decathlon.getProductImportStatus(payload.importId)
        : await decathlon.getOfferImportStatus(payload.importId);

    // CONFIRMED live 2026-09-18: P42 (product) and OF02 (offer) use ENTIRELY DIFFERENT field names
    // for the same concepts — P42 has no `status`/`lines_in_error`/`lines_in_success` fields at all
    // (they're `import_status`/`transform_lines_in_error`/`transform_lines_in_success` instead). This
    // was previously read unconditionally as if both shapes matched OF02, so `status` was always
    // `undefined` for a real product-import poll — every product sync sat at PENDING forever, never
    // resolving out of SyncLog's PROCESSING status. See types.ts's ImportStatusResult doc comment.
    const status = payload.kind === "product" ? statusResult.import_status : statusResult.status;
    const linesInError = payload.kind === "product" ? statusResult.transform_lines_in_error : statusResult.lines_in_error;
    const linesInSuccess = payload.kind === "product" ? statusResult.transform_lines_in_success : statusResult.lines_in_success;

    // "RUNNING" is the confirmed in-progress value (see types.ts) — anything not in the terminal set
    // below is treated as still-pending, which also safely covers any other unconfirmed in-progress
    // value this defensively falls through to.
    if (status !== "COMPLETE" && status !== "COMPLETE_WITH_ERRORS" && status !== "FAILED") {
      return { status: "PENDING" };
    }

    // CONFIRMED live 2026-09-15: `status: "COMPLETE"` does NOT mean every line succeeded — a real
    // response had status COMPLETE with lines_in_error: 1, lines_in_success: 0. Use the line counts
    // when present; only fall back to the (less reliable) status string when they're absent.
    const hasLineCounts = linesInError !== undefined || linesInSuccess !== undefined;
    const transformOk = hasLineCounts ? (linesInError ?? 0) === 0 : status !== "FAILED";

    // ── Stage 2, products only: integration into Decathlon's catalog ────────────────────────────
    // A clean transformation is NOT a published product. `import_status: COMPLETE` covers only the
    // transformation stage; Decathlon then integrates the transformed rows and reports that stage
    // separately in `integration_details`, which appears some time later. Judging the import on the
    // transform counts alone reported a total failure as a success (CONFIRMED live 2026-09-20:
    // transform_lines_in_error 0 / in_success 4, while integration said rejected_products 4 and
    // products_successfully_synchronized 0). Until that second stage reports, the import is still
    // running — so keep polling rather than resolving on stage 1.
    const integration = payload.kind === "product" ? statusResult.integration_details : undefined;
    const integrationFailures = integration
      ? (integration.rejected_products ?? 0) +
        (integration.invalid_products ?? 0) +
        (integration.products_with_wrong_identifiers ?? 0) +
        (integration.products_with_synchronization_issues ?? 0) +
        (integration.products_not_accepted_in_time ?? 0) +
        (integration.products_not_synchronized_in_time ?? 0)
      : 0;
    const integrationSynced = integration?.products_successfully_synchronized ?? 0;

    if (payload.kind === "product" && transformOk && integrationSynced === 0 && integrationFailures === 0) {
      return { status: "PENDING" };
    }

    const overallOk =
      payload.kind === "product" ? transformOk && integrationFailures === 0 && integrationSynced > 0 : transformOk;

    // Both product reports matter and they say different things: the TRANSFORMATION report carries
    // per-attribute validation (including warnings, which is where a rejected title shows up), while
    // the INTEGRATION report explains rows that transformed cleanly but were still refused. Fetch
    // whichever Decathlon says exists — each is a soft failure, since a report can 404 for a while
    // after the stage that produced it completes (docs/api-mapping.md §4 items 7-8).
    const reportTexts: string[] = [];
    const fetchReport = async (label: string, fetcher: () => Promise<string>): Promise<void> => {
      try {
        const text = await fetcher();
        if (text.trim()) reportTexts.push(text);
      } catch (err) {
        logger.warn({ event: "import_report_fetch_failed", shopId, importId: payload.importId, report: label, err: String(err) });
      }
    };

    if (payload.kind === "product") {
      if (statusResult.has_transformation_error_report) {
        await fetchReport("transformation", () => decathlon.getProductImportTransformationErrorReport(payload.importId));
      }
      if (statusResult.has_error_report) {
        await fetchReport("integration", () => decathlon.getProductImportErrorReport(payload.importId));
      }
      if (reportTexts.length === 0 && overallOk) {
        await fetchReport("success", () => decathlon.getProductImportSuccessReport(payload.importId));
      }
    } else if (statusResult.has_error_report || !overallOk) {
      await fetchReport("offer-error", () => decathlon.getOfferImportErrorReport(payload.importId));
    }

    // Both reports key their rows on this app's own SKU (shop_sku in the transformation report,
    // ProductIdentifier in the integration one), so per-SKU findings merge cleanly across the two.
    const parsed = new Map<string, ParsedReportRow>();
    for (const text of reportTexts) {
      for (const [sku, row] of parseReportText(text)) {
        const prior = parsed.get(sku);
        parsed.set(sku, {
          ok: (prior?.ok ?? true) && row.ok,
          decathlonId: row.decathlonId ?? prior?.decathlonId,
          error: [prior?.error, row.error].filter(Boolean).join("; ") || undefined,
          warning: [prior?.warning, row.warning].filter(Boolean).join("; ") || undefined,
        });
      }
    }
    const reportText = reportTexts.join("\n\n");
    // When the reports name specific failing rows, trust them per row; otherwise the aggregate
    // counters are all there is to go on, so a failed import fails every variant in it.
    const anyRowErrors = [...parsed.values()].some((r) => r.error);
    const variantErrors: string[] = [];

    for (const shopifyVariantId of payload.shopifyVariantIds) {
      const mapping = await repositories.productMappings.findByVariant(shopId, shopifyVariantId);
      if (!mapping) continue;
      const row = parsed.get(mapping.sku);
      const ok = overallOk || (anyRowErrors ? !row?.error : false);
      if (!ok) {
        // A warning is worth reporting on a failed row even when it isn't itself the error: a title
        // that fails Decathlon's script validation is reported as a *warning* on the transformation
        // stage and only shows up as a rejection one stage later, with no explanation of its own.
        const detail = [row?.error, row?.warning].filter(Boolean).join(" | ");
        variantErrors.push(`${mapping.sku}: ${detail || `rejected by Decathlon (import ${payload.importId})`}`);
      }
      if (ok) {
        const decathlonId = row?.decathlonId;
        await repositories.productMappings.markSynced(
          shopId,
          shopifyVariantId,
          payload.kind === "product" ? decathlonId ?? mapping.decathlonProductId ?? "" : mapping.decathlonProductId ?? "",
          payload.kind === "offer" ? decathlonId ?? mapping.decathlonOfferId ?? undefined : mapping.decathlonOfferId ?? undefined,
        );
      } else {
        await repositories.productMappings.markFailed(
          shopId,
          shopifyVariantId,
          row?.error ?? row?.warning ?? `Decathlon ${payload.kind} import reported failure (job status: ${status})`,
        );
      }
    }

    // Always give the merchant *something* actionable: per-row detail when a report parsed any,
    // otherwise the stage counters plus the import id so it can still be looked up directly in the
    // Decathlon Seller Portal. A blank "—" in the Sync Logs UI is never an acceptable outcome.
    const stageSummary =
      payload.kind === "product" && integration
        ? `transformation: ${linesInSuccess ?? 0} ok / ${linesInError ?? 0} error / ${
            statusResult.transform_lines_with_warning ?? 0
          } warning; integration: ${integrationSynced} published / ${integrationFailures} refused`
        : `status: ${status}${hasLineCounts ? `, ${linesInError ?? 0} line(s) in error` : ""}`;

    const errorMessage = overallOk
      ? undefined
      : variantErrors.length > 0
        ? `Decathlon refused this import (${stageSummary}) — ${variantErrors.join("; ")}`
        : `Decathlon ${payload.kind} import ${payload.importId} failed (${stageSummary})${
            reportText ? "" : " — detailed error report not yet available from Decathlon; check again shortly or look up this import id in the Decathlon Seller Portal"
          }`;

    await repositories.syncLogs.resolvePending({
      shopId,
      syncJobId: payload.syncJobId,
      type: payload.kind === "product" ? "PRODUCT_SYNC" : "OFFER_SYNC",
      status: overallOk ? "SUCCESS" : "FAILED",
      correlationId,
      itemLabel: payload.itemLabel,
      errorMessage,
      responseSummary: maskSecrets({
        status,
        integration_details: integration,
        reportPreview: reportText.slice(0, 4000),
      }) as object,
    });
    if (payload.syncJobId) {
      await repositories.syncJobs.finish(payload.syncJobId, overallOk ? "SUCCESS" : "FAILED", errorMessage);
    }

    return {
      status: "TERMINAL",
      result: overallOk ? "SUCCESS" : "FAILED",
      kind: payload.kind,
      shopId,
      shopifyVariantIds: payload.shopifyVariantIds,
      correlationId,
    };
  }

  /**
   * Called by the worker when an import has been polled MAX_IMPORT_POLL_ATTEMPTS times without ever
   * reaching a terminal state. Without this a stalled import leaves its SyncLog on PROCESSING
   * forever, which is indistinguishable from "still working" to the merchant.
   */
  async failStalledImport(payload: ImportStatusPollJobPayload): Promise<void> {
    const { repositories } = this.deps;
    const message =
      `Decathlon ${payload.kind} import ${payload.importId} never reported a final result after ` +
      `${payload.pollAttempt ?? MAX_IMPORT_POLL_ATTEMPTS} status checks — look this import id up in the ` +
      `Decathlon Seller Portal to see where it stalled.`;
    await repositories.syncLogs.resolvePending({
      shopId: payload.shopId,
      syncJobId: payload.syncJobId,
      type: payload.kind === "product" ? "PRODUCT_SYNC" : "OFFER_SYNC",
      status: "FAILED",
      correlationId: payload.correlationId ?? randomUUID(),
      itemLabel: payload.itemLabel,
      errorMessage: message,
    });
    if (payload.syncJobId) {
      await repositories.syncJobs.finish(payload.syncJobId, "FAILED", message);
    }
    this.deps.logger.error({ event: "import_poll_gave_up", shopId: payload.shopId, importId: payload.importId });
  }

  // ── Order import (Phase 6) ──────────────────────────────────────────────────────────────────

  /**
   * Fetches exactly ONE OR11 page per run — never loops to pagination-exhaustion inside a single
   * job — to respect the documented ~1/min hard call-frequency ceiling (docs/api-mapping.md §2.4);
   * catch-up across many pages happens over multiple scheduled runs, which is safe because
   * OrderMapping's unique constraint makes re-processing overlap a no-op (docs/sync-strategy.md §9).
   */
  async importOrders(payload: OrderImportJobPayload): Promise<void> {
    const { repositories, decathlon, shopify, logger } = this.deps;
    const shopId = payload.shopId;
    const correlationId = payload.correlationId ?? randomUUID();
    const syncJobId = await this.ensureSyncJob(shopId, "ORDER_IMPORT", payload, payload.syncJobId);

    const config = await repositories.syncConfigurations.getOrCreateDefault(shopId);
    const offset = config.orderImportCursorOffset ?? 0;

    // The real shop currency, not SyncConfiguration.defaultCurrency — that field tracks the
    // Decathlon marketplace's currency assumption for outbound offers and can differ from what the
    // Shopify store is actually set to (see docs/api-mapping.md §4 item 7: orderCreate rejects
    // shopMoney whose currencyCode isn't the store's own).
    const shopInfo = await shopify.request<ShopInfoResponse>(SHOP_INFO_QUERY);
    const shopCurrency = shopInfo.shop.currencyCode;

    let raw;
    try {
      raw = await decathlon.listOrdersAwaitingShipment({ offset, max: 50 });
    } catch (err) {
      await this.failJob(shopId, syncJobId, "ORDER_IMPORT", correlationId, err);
      throw err;
    }

    const orders = extractOrdersArray(raw);
    if (orders.length === 0) {
      if (offset > 0) {
        await repositories.syncConfigurations.update(shopId, { orderImportCursorOffset: 0 });
      }
      await repositories.syncJobs.finish(syncJobId, "SUCCESS");
      return;
    }

    let processed = 0;
    let lastDate: string | undefined;
    for (const dto of orders) {
      processed += 1;
      try {
        await this.importOneOrder(shopId, dto, correlationId, syncJobId, shopCurrency);
      } catch (err) {
        logger.error({ event: "order_import_line_failed", shopId, correlationId, err: String(err) });
        await repositories.syncLogs.write({
          shopId,
          syncJobId,
          type: "ORDER_IMPORT",
          status: "FAILED",
          correlationId,
          decathlonId: dto.order_id ?? dto.commercial_id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      lastDate = dto.created_date ?? lastDate;
      await repositories.syncJobs.updateProgress(syncJobId, processed, orders.length);
    }

    await repositories.syncConfigurations.update(shopId, {
      orderImportCursorOffset: offset + orders.length,
      orderImportCursorDate: lastDate ? new Date(lastDate) : undefined,
    });
    await repositories.syncJobs.finish(syncJobId, "SUCCESS");
  }

  private async importOneOrder(
    shopId: string,
    dto: Parameters<typeof normalizeDecathlonOrder>[0],
    correlationId: string,
    syncJobId: string,
    shopCurrency: string,
  ): Promise<void> {
    const { repositories, shopify } = this.deps;
    const normalized = normalizeDecathlonOrder(dto);

    const alreadyImported =
      (await repositories.orderMappings.findByDecathlonOrderId(shopId, normalized.externalId)) ??
      (normalized.commercialId ? await repositories.orderMappings.repairLegacyId(shopId, normalized.externalId, normalized.commercialId) : null);
    if (alreadyImported) return; // idempotent — already processed in an earlier (possibly overlapping) page

    const matchedVariantIdByLineId = new Map<string, string>();
    const productMappingByLineId = new Map<string, string>();
    for (const item of normalized.items) {
      const mapping = await matchOrderLine(this.deps, shopId, item);
      if (mapping) {
        matchedVariantIdByLineId.set(item.decathlonOrderLineId, mapping.shopifyVariantId);
        productMappingByLineId.set(item.decathlonOrderLineId, mapping.id);
      }
    }
    const anyUnmatched = normalized.items.some((i) => !matchedVariantIdByLineId.has(i.decathlonOrderLineId));

    const orderInput = buildShopifyOrderInput(normalized, matchedVariantIdByLineId, shopCurrency);
    const created = await shopify.request<OrderCreateResponse>(ORDER_CREATE_MUTATION, { order: orderInput });
    if (created.orderCreate.userErrors.length > 0 || !created.orderCreate.order) {
      this.deps.logger.error({
        event: "order_create_user_errors",
        shopId,
        decathlonOrderId: normalized.externalId,
        userErrors: created.orderCreate.userErrors,
        currency: orderInput.currency,
        lineItems: orderInput.lineItems,
      });
      throw new Error(`Shopify orderCreate failed: ${created.orderCreate.userErrors.map((e) => e.message).join("; ")}`);
    }
    const shopifyOrderId = created.orderCreate.order.id;

    await repositories.orderMappings.createIfNotExists(shopId, shopifyOrderId, normalized, {
      matchStatus: anyUnmatched ? "PENDING" : "SYNCED",
      productMappingByLineId,
    });

    await repositories.syncLogs.write({
      shopId,
      syncJobId,
      type: "ORDER_IMPORT",
      status: "SUCCESS",
      correlationId,
      decathlonId: normalized.externalId,
      shopifyId: shopifyOrderId,
    });
  }

  // ── Post-import lifecycle — see order-lifecycle.ts ──────────────────────────────────────────────

  syncFulfillment(payload: FulfillmentSyncJobPayload): Promise<void> {
    return this.lifecycle.syncFulfillment(payload);
  }

  syncRefund(payload: RefundSyncJobPayload): Promise<void> {
    return this.lifecycle.syncRefund(payload);
  }

  syncReturns(payload: ReturnSyncJobPayload): Promise<void> {
    return this.lifecycle.syncReturns(payload);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Per-product `custom.decathlon_category` metafield wins; otherwise the shop's CategoryMapping
   * rule for the product's Shopify product type. The error names both routes because which one a
   * merchant should reach for depends on whether this is a one-off or a whole product type.
   */
  private async resolveCategoryCode(shopId: string, product: NormalizedProduct): Promise<string> {
    if (product.categoryCode) return product.categoryCode;
    if (product.productType) {
      const rule = await this.deps.repositories.categoryMappings.findByProductType(shopId, product.productType);
      if (rule) return rule.decathlonCategoryCode;
    }
    throw new ValidationError(
      product.productType
        ? `"${product.title}" has no Decathlon category. Map its product type "${product.productType}" on the Mappings page, or set a "Decathlon Category" metafield on the product itself.`
        : `"${product.title}" has no product type or Shopify product category. Give it a type under "Products without a type" on the Mappings page, then map that type to a Decathlon category.`,
    );
  }

  private async ensureSyncJob(shopId: string, type: SyncJobType, payload: unknown, existingId?: string): Promise<string> {
    if (existingId) {
      await this.deps.repositories.syncJobs.start(existingId);
      return existingId;
    }
    // Fallback for direct engine invocation without a producer (e.g. the live-validation script) —
    // the normal path always has a producer-created SyncJob id already attached to the payload.
    const job = await this.deps.repositories.syncJobs.create(shopId, type, payload as never);
    await this.deps.repositories.syncJobs.start(job.id);
    return job.id;
  }

  private async failJob(
    shopId: string,
    syncJobId: string,
    type: SyncJobType,
    correlationId: string,
    err: unknown,
    itemLabel?: string,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.deps.repositories.syncLogs.write({
      shopId,
      syncJobId,
      type,
      status: "FAILED",
      correlationId,
      itemLabel,
      errorMessage: message,
    });
    await this.deps.repositories.syncJobs.finish(syncJobId, "FAILED", message);
    this.deps.logger.error({ event: "sync_job_failed", shopId, syncJobId, type, err: message });
  }

  private async resolveProductIds(shopify: ShopifyAdminGraphqlClient, variantIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (variantIds.length === 0) return result;
    const res = await shopify.request<VariantsToProductsResponse>(VARIANTS_TO_PRODUCTS_QUERY, { ids: variantIds });
    for (const node of res.nodes) {
      if (node) result.set(node.id, node.product.id);
    }
    return result;
  }

  private async fetchFreshVariants(
    shopify: ShopifyAdminGraphqlClient,
    productIds: string[],
    config: SyncConfiguration,
    logger: Logger,
    shopId: string,
  ): Promise<Map<string, NormalizedVariant>> {
    const byVariantId = new Map<string, NormalizedVariant>();
    for (const productId of productIds) {
      try {
        const raw = await shopify.request<ProductWithVariantsResponse>(PRODUCT_WITH_VARIANTS_QUERY, { id: productId });
        const product = normalizeShopifyProduct(raw, config.defaultCurrency);
        for (const v of product.variants) {
          if (v.shopifyVariantId) byVariantId.set(v.shopifyVariantId, v);
        }
      } catch (err) {
        logger.warn({ event: "offer_sync_refetch_failed", shopId, productId, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return byVariantId;
  }
}
