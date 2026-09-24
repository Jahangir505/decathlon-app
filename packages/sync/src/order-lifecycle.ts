import { randomUUID } from "node:crypto";
import type { OrderLineItem, OrderMapping, ProductMapping, Repositories, SyncJobType, SyncStatus } from "@shopify-decathlon/database";
import type {
  DecathlonCarrier,
  DecathlonClient,
  DecathlonOrderLineDto,
  DecathlonReturnDto,
  RefundInput,
  ShipmentTracking,
} from "@shopify-decathlon/decathlon";
import type { Logger } from "@shopify-decathlon/logger";
import { maskSecrets } from "@shopify-decathlon/logger";
import { TAGS_ADD_MUTATION, type ShopifyAdminGraphqlClient, type TagsAddResponse } from "@shopify-decathlon/shopify";
import { DecathlonApiError, DecathlonOutcomeUnknownError } from "@shopify-decathlon/shared";
import type { FulfillmentSyncJobPayload, RefundSyncJobPayload, ReturnSyncJobPayload, ShopifyLineRef } from "./queues";

export interface OrderLifecycleDeps {
  repositories: Repositories;
  decathlon: DecathlonClient;
  shopify: ShopifyAdminGraphqlClient;
  logger: Logger;
}

type OrderWithLines = OrderMapping & { lineItems: Array<OrderLineItem & { productMapping?: ProductMapping | null }> };

/** Return states Decathlon will not move out of again (RT11, observed live: CLOSED, CANCELED). */
const TERMINAL_RETURN_STATES = ["CLOSED", "CANCELED", "REJECTED"];

/** RE01 `GET /api/reasons/REFUND` on this instance (confirmed live 2026-09-21). */
const REFUND_REASON = { OUT_OF_STOCK: "15", ITEM_RETURNED: "17", AGREEMENT_WITH_VENDOR: "19" } as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: Array<number | undefined>) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/**
 * Maps Shopify order lines onto Decathlon order lines, most reliable key first:
 *   1. the `_decathlon_order_line_id` property set on every line this app imports,
 *   2. the variant the line was matched to at import time,
 *   3. the SKU.
 * A quantity spanning several Decathlon lines of the same variant is split across them. Whatever
 * can't be placed is returned as unresolved rather than guessed at.
 */
export function resolveLines<T extends ShopifyLineRef>(
  orderLines: OrderWithLines["lineItems"],
  refs: T[],
): { resolved: Array<{ decathlonOrderLineId: string; quantity: number; ref: T }>; unresolved: T[] } {
  const capacity = new Map(orderLines.map((l) => [l.decathlonOrderLineId, l.quantity]));
  const resolved: Array<{ decathlonOrderLineId: string; quantity: number; ref: T }> = [];
  const unresolved: T[] = [];

  for (const ref of refs) {
    let candidates = ref.decathlonOrderLineId ? orderLines.filter((l) => l.decathlonOrderLineId === ref.decathlonOrderLineId) : [];
    if (candidates.length === 0 && ref.variantId) {
      candidates = orderLines.filter((l) => l.productMapping?.shopifyVariantId === ref.variantId);
    }
    if (candidates.length === 0 && ref.sku) {
      candidates = orderLines.filter((l) => l.sku === ref.sku);
    }
    let left = ref.quantity;
    for (const line of candidates) {
      const take = Math.min(left, capacity.get(line.decathlonOrderLineId) ?? 0);
      if (take <= 0) continue;
      resolved.push({ decathlonOrderLineId: line.decathlonOrderLineId, quantity: take, ref });
      capacity.set(line.decathlonOrderLineId, (capacity.get(line.decathlonOrderLineId) ?? 0) - take);
      left -= take;
      if (left === 0) break;
    }
    if (left > 0) unresolved.push({ ...ref, quantity: left });
  }
  return { resolved, unresolved };
}

/**
 * Shopify's free-text tracking company -> Decathlon tracking. A carrier Decathlon knows (SH21) is
 * sent by code, which is what lets Decathlon build the tracking link for the customer; anything else
 * goes as a free-text carrier name + URL, which real orders on this instance also carry.
 */
export function resolveTracking(
  company: string | undefined,
  trackingNumber: string | undefined,
  trackingUrl: string | undefined,
  carriers: DecathlonCarrier[],
): ShipmentTracking | undefined {
  if (!company && !trackingNumber) return undefined;
  const full = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = (s: string) => full(s.replace(/\(.*?\)/g, ""));
  let carrier: DecathlonCarrier | undefined;
  if (company) {
    const f = full(company);
    carrier = carriers.find((c) => full(c.code) === f || full(c.label) === f);
    if (!carrier) {
      // "Royal Mail" vs "Royal Mail (UK)" — only when unambiguous: "UPS" matches both "UPS" and
      // "UPS (UK)", and picking one would send the customer to the wrong tracking site.
      const byBase = carriers.filter((c) => base(c.label) === base(company));
      if (byBase.length === 1) carrier = byBase[0];
    }
  }
  if (carrier) return { carrier_code: carrier.code, tracking_number: trackingNumber };
  return { carrier_name: company, tracking_number: trackingNumber, tracking_url: trackingUrl };
}

/**
 * Post-import order lifecycle — everything that happens to a Decathlon order after it lands in
 * Shopify (docs/architecture.md §7):
 *   - syncFulfillment: Shopify fulfillment -> ST01 shipment (+ ST23 when tracking changes later)
 *   - syncRefund:      Shopify refund / cancellation -> OR28
 *   - syncReturns:     Decathlon returns (RT11) -> ReturnMapping + a tag on the Shopify order
 * Every request/response shape used here was confirmed against preprod on 2026-09-21, including a
 * real OR28 refund. The one exception is ST01's SUCCESS body: no order in state SHIPPING existed
 * there to ship.
 */
export class OrderLifecycleSync {
  constructor(private readonly deps: OrderLifecycleDeps) {}

  // ── Fulfillment ──────────────────────────────────────────────────────────────────────────────

  async syncFulfillment(payload: FulfillmentSyncJobPayload): Promise<void> {
    const { repositories, decathlon, logger } = this.deps;
    const { shopId } = payload;
    const correlationId = payload.correlationId ?? randomUUID();
    const syncJobId = await this.startJob(shopId, "FULFILLMENT_SYNC", payload, payload.syncJobId);

    const order = await this.loadOrder(shopId, payload.shopifyOrderId);
    if (!order) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "Not an order imported from Decathlon");
      return;
    }
    const label = `Shipment — Decathlon order ${order.decathlonCommercialId ?? order.decathlonOrderId}`;
    const log = (status: SyncStatus, extra: { errorMessage?: string; requestSummary?: unknown; responseSummary?: unknown } = {}) =>
      this.log(shopId, syncJobId, "FULFILLMENT_SYNC", status, correlationId, label, order, extra);

    if (payload.status !== "success") {
      // Mirakl has no "unship": a cancelled Shopify fulfillment can't be reflected on Decathlon.
      const message =
        payload.status === "cancelled"
          ? "Fulfillment was cancelled in Shopify — Decathlon has no way to undo a confirmed shipment; contact Decathlon if it was already sent"
          : `Fulfillment status is "${payload.status}", only successful fulfillments are sent to Decathlon`;
      if (payload.status === "cancelled") await log("SKIPPED", { errorMessage: message });
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", message);
      return;
    }

    const carriers = await decathlon.listCarriers().catch((err) => {
      logger.warn({ event: "carrier_list_failed", shopId, err: String(err) });
      return [] as DecathlonCarrier[];
    });
    const tracking = resolveTracking(payload.trackingCompany, payload.trackingNumber, payload.trackingUrl, carriers);

    const existing = await repositories.shipmentMappings.findByFulfillment(shopId, payload.shopifyFulfillmentId);
    if (existing?.status === "SUCCESS") {
      await this.updateTracking(existing, tracking, log, syncJobId);
      return;
    }

    const claim = await repositories.shipmentMappings.claim(shopId, order.id, payload.shopifyFulfillmentId);
    if (!claim) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "This fulfillment is already being sent to Decathlon");
      return;
    }
    const fail = async (message: string, extra: { requestSummary?: unknown; responseSummary?: unknown } = {}) => {
      await repositories.shipmentMappings.update(claim.id, { status: "FAILED", lastError: message });
      await log("FAILED", { errorMessage: message, ...extra });
      await repositories.syncJobs.finish(syncJobId, "FAILED", message);
    };

    const { resolved, unresolved } = resolveLines(order.lineItems, payload.lines);
    if (unresolved.length > 0 || resolved.length === 0) {
      await fail(
        `Could not match fulfilled line(s) to the Decathlon order: ${
          unresolved.map((u) => `${u.sku ?? u.variantId ?? "unknown"} x${u.quantity}`).join(", ") || "no lines"
        }`,
      );
      return;
    }

    const shipment = {
      order_id: order.decathlonOrderId,
      shipped: true,
      shipment_lines: resolved.map((r) => ({ order_line_id: r.decathlonOrderLineId, quantity: r.quantity })),
      tracking,
    };

    let result;
    try {
      result = await decathlon.createShipments([shipment]);
    } catch (err) {
      await fail(
        err instanceof DecathlonOutcomeUnknownError
          ? `${err.message}. Check the order in the Decathlon Seller Portal before retrying.`
          : err instanceof Error
            ? err.message
            : String(err),
        { requestSummary: shipment },
      );
      return;
    }

    // ST01 answers 201 even when it refused the shipment — the verdict is in the body.
    if (result.shipment_errors?.length || !result.shipment_success?.length) {
      await fail(
        `Decathlon refused the shipment: ${result.shipment_errors?.map((e) => e.message).join("; ") || "no shipment was created"}`,
        { requestSummary: shipment, responseSummary: result },
      );
      return;
    }

    const decathlonShipmentId = result.shipment_success[0]?.id;
    await repositories.shipmentMappings.update(claim.id, {
      status: "SUCCESS",
      decathlonShipmentId,
      carrierCode: tracking?.carrier_code,
      carrierName: tracking?.carrier_name,
      trackingNumber: tracking?.tracking_number,
      trackingUrl: tracking?.tracking_url,
    });
    if (decathlonShipmentId) {
      await repositories.orderMappings.recordShipment(shopId, order.decathlonOrderId, decathlonShipmentId, payload.shopifyFulfillmentId);
    }
    await this.refreshOrderState(shopId, order.decathlonOrderId);
    await log("SUCCESS", { requestSummary: shipment, responseSummary: result });
    await repositories.syncJobs.finish(syncJobId, "SUCCESS");
  }

  /** A `fulfillments/update` on an already-shipped fulfillment — normally tracking added or corrected. */
  private async updateTracking(
    mapping: { id: string; decathlonShipmentId: string | null; trackingNumber: string | null; carrierCode: string | null; carrierName: string | null },
    tracking: ShipmentTracking | undefined,
    log: (status: SyncStatus, extra?: { errorMessage?: string; requestSummary?: unknown; responseSummary?: unknown }) => Promise<void>,
    syncJobId: string,
  ): Promise<void> {
    const { repositories, decathlon } = this.deps;
    // `?? null` on both sides: an unset column may come back null or undefined depending on how the
    // row was written, and treating those as different re-sent identical tracking on every redelivery.
    const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);
    const unchanged =
      !tracking?.tracking_number ||
      (same(tracking.tracking_number, mapping.trackingNumber) &&
        same(tracking.carrier_code, mapping.carrierCode) &&
        same(tracking.carrier_name, mapping.carrierName));
    if (unchanged) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "Tracking unchanged");
      return;
    }
    if (!mapping.decathlonShipmentId) {
      const message = "Tracking changed, but the Decathlon shipment id was never returned — update tracking in the Seller Portal";
      await log("FAILED", { errorMessage: message });
      await repositories.syncJobs.finish(syncJobId, "FAILED", message);
      return;
    }
    const update = { id: mapping.decathlonShipmentId, tracking };
    const result = await decathlon.updateShipmentTracking([update]);
    if (result.shipment_errors?.length) {
      const message = `Decathlon refused the tracking update: ${result.shipment_errors.map((e) => e.message).join("; ")}`;
      await log("FAILED", { errorMessage: message, requestSummary: update, responseSummary: result });
      await repositories.syncJobs.finish(syncJobId, "FAILED", message);
      return;
    }
    await repositories.shipmentMappings.update(mapping.id, {
      carrierCode: tracking.carrier_code ?? null,
      carrierName: tracking.carrier_name ?? null,
      trackingNumber: tracking.tracking_number,
      trackingUrl: tracking.tracking_url ?? null,
    });
    await log("SUCCESS", { requestSummary: update, responseSummary: result });
    await repositories.syncJobs.finish(syncJobId, "SUCCESS");
  }

  // ── Refunds ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Decathlon collects the customer's payment, so a refund made only in Shopify never reaches the
   * customer: every refund and cancellation has to go through OR28. Guarantees, in order of
   * importance: never refund twice (claim row + outcome-unknown check below), never refund more
   * than Decathlon says is left, and never partially apply a refund that can't be fully mapped.
   */
  async syncRefund(payload: RefundSyncJobPayload): Promise<void> {
    const { repositories, decathlon } = this.deps;
    const { shopId } = payload;
    const correlationId = payload.correlationId ?? randomUUID();
    const syncJobId = await this.startJob(shopId, "REFUND_SYNC", payload, payload.syncJobId);

    const order = await this.loadOrder(shopId, payload.shopifyOrderId);
    if (!order) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "Not an order imported from Decathlon");
      return;
    }
    const label = `${payload.mode === "cancel" ? "Cancellation" : "Refund"} — Decathlon order ${order.decathlonCommercialId ?? order.decathlonOrderId}`;
    const log = (status: SyncStatus, extra: { errorMessage?: string; requestSummary?: unknown; responseSummary?: unknown } = {}) =>
      this.log(shopId, syncJobId, "REFUND_SYNC", status, correlationId, label, order, extra);

    const refundKey = payload.mode === "cancel" ? `cancel:${payload.shopifyOrderId}` : payload.shopifyRefundId;
    if (!refundKey) {
      await repositories.syncJobs.finish(syncJobId, "FAILED", "Refund job has no Shopify refund id");
      return;
    }
    const claim = await repositories.refundMappings.claim(shopId, order.id, refundKey);
    if (!claim) {
      await repositories.syncJobs.finish(syncJobId, "SKIPPED", "This refund was already sent to Decathlon");
      return;
    }
    const finish = async (status: "FAILED" | "SKIPPED", message: string, extra: { requestSummary?: unknown; responseSummary?: unknown } = {}) => {
      await repositories.refundMappings.finish(claim.id, status, { lastError: message });
      await log(status, { errorMessage: message, ...extra });
      await repositories.syncJobs.finish(syncJobId, status, message);
    };

    const [dOrder] = await decathlon.getOrders([order.decathlonOrderId]);
    if (!dOrder) {
      await finish("FAILED", `Decathlon order ${order.decathlonOrderId} not found`);
      return;
    }
    const dLines = dOrder.order_lines ?? [];
    const currentRefundIds = dLines.flatMap((l) => (l.refunds ?? []).map((r) => String(r.id)));

    // Retry after an unconfirmed attempt: if Decathlon now shows refunds that weren't there when
    // this refund was first attempted, the earlier request went through — don't send it again.
    const prior = claim.decathlonRefundIds as { before?: string[] } | null;
    if (prior?.before) {
      const appeared = currentRefundIds.filter((id) => !prior.before!.includes(id));
      if (appeared.length > 0) {
        await repositories.refundMappings.finish(claim.id, "SUCCESS", { decathlonRefundIds: { before: prior.before, created: appeared } });
        await log("SUCCESS", { responseSummary: { note: "Earlier unconfirmed attempt was applied by Decathlon", refundIds: appeared } });
        await repositories.syncJobs.finish(syncJobId, "SUCCESS");
        return;
      }
    }
    const before = prior?.before ?? currentRefundIds;
    await repositories.refundMappings.finish(claim.id, "PROCESSING", { decathlonRefundIds: { before } });

    const config = await repositories.syncConfigurations.getOrCreateDefault(shopId);
    const currency = dOrder.currency_iso_code ?? order.lineItems[0]?.currency ?? "EUR";

    let built: { refunds: RefundInput[]; problems: string[] };
    try {
      built = payload.mode === "cancel" ? buildCancellationRefunds(dLines, currency, config.refundReasonCode) : buildRefunds(order, dLines, payload, currency, config.refundReasonCode);
    } catch (err) {
      await finish("FAILED", err instanceof Error ? err.message : String(err));
      return;
    }
    const { refunds, problems } = built;
    if (refunds.length === 0) {
      await finish("SKIPPED", problems.join("; ") || "Nothing left to refund on Decathlon for this order");
      return;
    }

    let result;
    try {
      result = await decathlon.refundOrderLines(refunds);
    } catch (err) {
      const message =
        err instanceof DecathlonOutcomeUnknownError
          ? `${err.message}. A retry checks Decathlon first and will not refund twice.`
          : err instanceof DecathlonApiError || err instanceof Error
            ? err.message
            : String(err);
      await finish("FAILED", message, { requestSummary: refunds });
      return;
    }

    const total = round2(sum(refunds.map((r) => r.amount + (r.shipping_amount ?? 0))));
    const created = (result.refunds ?? []).map((r) => r.refund_id ?? r.id).filter((id): id is string => Boolean(id)).map(String);
    await repositories.refundMappings.finish(claim.id, "SUCCESS", { decathlonRefundIds: { before, created }, amount: total, currency, lastError: null });
    await this.refreshOrderState(shopId, order.decathlonOrderId);
    await log("SUCCESS", {
      errorMessage: problems.length ? `Refunded ${total} ${currency}, with adjustments: ${problems.join("; ")}` : undefined,
      requestSummary: refunds,
      responseSummary: result,
    });
    await repositories.syncJobs.finish(syncJobId, "SUCCESS");
  }

  // ── Returns ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Returns are opened by customers on Decathlon's side; this mirrors them locally and tags the
   * Shopify order (`decathlon-return`, `decathlon-return-<state>`) so a merchant working in Shopify
   * sees them. The refund for a return is still the merchant's call: refund in Shopify and syncRefund
   * sends it to Decathlon. RT11 can only sort by creation date, so the newest page catches new
   * returns and each still-open return is re-checked individually for state changes.
   */
  async syncReturns(payload: ReturnSyncJobPayload): Promise<void> {
    const { repositories, decathlon, logger } = this.deps;
    const { shopId } = payload;
    const correlationId = payload.correlationId ?? randomUUID();

    const seen = new Map<string, DecathlonReturnDto>();
    const newest = await decathlon.listReturns({ limit: 50, sort: "date_created,DESC" });
    for (const r of newest.data) seen.set(r.id, r);

    for (const open of await repositories.returnMappings.listOpen(shopId, TERMINAL_RETURN_STATES, 20)) {
      if (seen.has(open.decathlonReturnId)) continue;
      const commercialId = open.orderMapping.decathlonCommercialId;
      if (!commercialId) continue;
      const res = await decathlon.listReturns({ order_commercial_id: commercialId, limit: 50 });
      for (const r of res.data) seen.set(r.id, r);
    }

    for (const ret of seen.values()) {
      try {
        await this.applyReturn(shopId, ret, correlationId);
      } catch (err) {
        logger.error({ event: "return_sync_failed", shopId, returnId: ret.id, err: String(err) });
      }
    }
  }

  private async applyReturn(shopId: string, ret: DecathlonReturnDto, correlationId: string): Promise<void> {
    const { repositories, shopify } = this.deps;
    const order =
      (ret.order_id ? await repositories.orderMappings.findByDecathlonOrderId(shopId, ret.order_id) : null) ??
      (ret.order_commercial_id
        ? ((await repositories.orderMappings.findByCommercialId(shopId, ret.order_commercial_id)) ??
          // pre-2026-09-21 rows are keyed on the commercial id itself — see loadOrder
          (await repositories.orderMappings.findByDecathlonOrderId(shopId, ret.order_commercial_id)))
        : null);
    if (!order) return; // a return on an order this app didn't import

    const state = ret.state ?? "UNKNOWN";
    const previous = await repositories.returnMappings.findByDecathlonReturnId(shopId, ret.id);
    await repositories.returnMappings.upsert(shopId, order.id, ret.id, {
      status: state,
      reasonCode: ret.reason_code ?? undefined,
      rmaNumber: ret.rma ?? undefined,
      trackingNumber: ret.tracking?.tracking_number ?? undefined,
      carrierCode: ret.tracking?.carrier_code ?? undefined,
    });
    if (previous?.status === state) return;

    const tags = ["decathlon-return", `decathlon-return-${state.toLowerCase().replace(/_/g, "-")}`];
    const res = await shopify.request<TagsAddResponse>(TAGS_ADD_MUTATION, { id: order.shopifyOrderId, tags });
    const tagError = res.tagsAdd.userErrors.map((e) => e.message).join("; ");
    const lines = (ret.return_lines ?? []).map((l) => `${l.order_line_id} x${l.quantity ?? 1}`).join(", ");
    await repositories.syncLogs.write({
      shopId,
      type: "RETURN_SYNC",
      status: tagError ? "FAILED" : "SUCCESS",
      correlationId,
      decathlonId: ret.id,
      shopifyId: order.shopifyOrderId,
      itemLabel: `Return ${previous ? `${previous.status} → ${state}` : state} — Decathlon order ${order.decathlonCommercialId ?? order.decathlonOrderId}`,
      errorMessage: tagError || undefined,
      responseSummary: maskSecrets({ state, reason: ret.reason_code, lines, tracking: ret.tracking?.tracking_number }) as object,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The order mapping for a Shopify order, with rows imported before 2026-09-21 repaired first:
   * those hold the commercial id where the `order_id` belongs, which no order-scoped Decathlon call
   * accepts. Decathlon line ids are `<order_id>-<n>` (confirmed live), so the real id is recovered
   * from a stored line and only kept once OR11 confirms it belongs to the same commercial id.
   * (OR11 has no working commercial-id filter — `commercial_ids` is silently ignored and returns
   * every order — so this is the only reliable way back.)
   */
  private async loadOrder(shopId: string, shopifyOrderId: string): Promise<OrderWithLines | null> {
    const { repositories, decathlon, logger } = this.deps;
    const order = (await repositories.orderMappings.findByShopifyOrderIdWithLines(shopId, shopifyOrderId)) as OrderWithLines | null;
    if (!order || order.decathlonCommercialId) return order;

    const candidate = order.lineItems[0]?.decathlonOrderLineId.replace(/-\d+$/, "");
    if (!candidate || candidate === order.decathlonOrderId) return order;
    try {
      const [found] = await decathlon.getOrders([candidate]);
      if (found?.order_id === candidate && found.commercial_id === order.decathlonOrderId) {
        await repositories.orderMappings.rekey(order.id, candidate, found.commercial_id);
        logger.info({ event: "order_mapping_rekeyed", shopId, from: order.decathlonOrderId, to: candidate });
        return { ...order, decathlonOrderId: candidate, decathlonCommercialId: found.commercial_id };
      }
    } catch (err) {
      logger.warn({ event: "order_mapping_rekey_failed", shopId, orderId: order.decathlonOrderId, err: String(err) });
    }
    return order;
  }

  private async refreshOrderState(shopId: string, decathlonOrderId: string): Promise<void> {
    try {
      const [fresh] = await this.deps.decathlon.getOrders([decathlonOrderId]);
      if (fresh?.order_state) await this.deps.repositories.orderMappings.updateStatus(shopId, decathlonOrderId, fresh.order_state);
    } catch (err) {
      this.deps.logger.warn({ event: "order_state_refresh_failed", shopId, decathlonOrderId, err: String(err) });
    }
  }

  private async startJob(shopId: string, type: SyncJobType, payload: unknown, existingId?: string): Promise<string> {
    if (existingId) {
      await this.deps.repositories.syncJobs.start(existingId);
      return existingId;
    }
    const job = await this.deps.repositories.syncJobs.create(shopId, type, payload as never);
    await this.deps.repositories.syncJobs.start(job.id);
    return job.id;
  }

  private log(
    shopId: string,
    syncJobId: string,
    type: SyncJobType,
    status: SyncStatus,
    correlationId: string,
    itemLabel: string,
    order: OrderMapping,
    extra: { errorMessage?: string; requestSummary?: unknown; responseSummary?: unknown },
  ): Promise<void> {
    return this.deps.repositories.syncLogs
      .write({
        shopId,
        syncJobId,
        type,
        status,
        correlationId,
        itemLabel,
        decathlonId: order.decathlonOrderId,
        shopifyId: order.shopifyOrderId,
        errorMessage: extra.errorMessage,
        requestSummary: extra.requestSummary === undefined ? undefined : (maskSecrets(extra.requestSummary) as object),
        responseSummary: extra.responseSummary === undefined ? undefined : (maskSecrets(extra.responseSummary) as object),
      })
      .then(() => undefined);
  }
}

// ── OR28 payload builders (pure — exported for tests) ──────────────────────────────────────────

interface Remaining {
  amount: number;
  shipping: number;
  quantity: number;
}

function remainingOf(line: DecathlonOrderLineDto): Remaining {
  const refunds = line.refunds ?? [];
  return {
    amount: round2((line.price ?? 0) - sum(refunds.map((r) => r.amount))),
    shipping: round2((line.shipping_price ?? 0) - sum(refunds.map((r) => r.shipping_amount))),
    quantity: (line.quantity ?? 0) - sum(refunds.map((r) => r.quantity)),
  };
}

function reasonFor(line: DecathlonOrderLineDto, override: string | null | undefined, gesture = false): string {
  if (override) return override;
  if (gesture) return REFUND_REASON.AGREEMENT_WITH_VENDOR;
  return line.order_line_state === "SHIPPING" ? REFUND_REASON.OUT_OF_STOCK : REFUND_REASON.ITEM_RETURNED;
}

/** Order cancelled in Shopify: refund everything left on lines Decathlon hasn't shipped. Shipped
 *  lines are left alone — refunding goods already on their way needs an explicit Shopify refund. */
export function buildCancellationRefunds(
  dLines: DecathlonOrderLineDto[],
  currency: string,
  reasonOverride: string | null | undefined,
): { refunds: RefundInput[]; problems: string[] } {
  const refunds: RefundInput[] = [];
  const problems: string[] = [];
  for (const line of dLines) {
    if (!line.order_line_id) continue;
    if (line.order_line_state !== "SHIPPING") {
      if (line.order_line_state === "SHIPPED" || line.order_line_state === "RECEIVED") {
        problems.push(`${line.order_line_id} is already ${line.order_line_state} — refund it from Shopify if it should be`);
      }
      continue;
    }
    if (line.can_refund === false) continue;
    const left = remainingOf(line);
    if (left.amount + left.shipping <= 0.01) continue;
    refunds.push({
      order_line_id: line.order_line_id,
      quantity: Math.max(left.quantity, 0),
      amount: left.amount,
      shipping_amount: left.shipping,
      currency_iso_code: currency,
      reason_code: reasonFor(line, reasonOverride),
    });
  }
  return { refunds, problems };
}

/** One Shopify refund -> OR28 lines, capped at what Decathlon says is still refundable. */
export function buildRefunds(
  order: OrderWithLines,
  dLines: DecathlonOrderLineDto[],
  payload: RefundSyncJobPayload,
  currency: string,
  reasonOverride: string | null | undefined,
): { refunds: RefundInput[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(dLines.filter((l) => l.order_line_id).map((l) => [l.order_line_id!, l]));
  const remaining = new Map([...byId].map(([id, l]) => [id, remainingOf(l)]));
  const acc = new Map<string, { quantity: number; amount: number; shipping: number; gesture: boolean }>();
  const entry = (id: string) => {
    let e = acc.get(id);
    if (!e) acc.set(id, (e = { quantity: 0, amount: 0, shipping: 0, gesture: false }));
    return e;
  };

  const { resolved, unresolved } = resolveLines(order.lineItems, payload.lines ?? []);
  if (unresolved.length > 0) {
    // All or nothing: a half-applied refund is harder to reason about than a clear failure.
    throw new Error(
      `Could not match refunded line(s) to the Decathlon order: ${unresolved.map((u) => `${u.sku ?? u.variantId ?? "unknown"} x${u.quantity}`).join(", ")}`,
    );
  }
  for (const piece of resolved) {
    const e = entry(piece.decathlonOrderLineId);
    e.quantity += piece.quantity;
    e.amount += piece.ref.quantity > 0 ? (piece.ref.amount * piece.quantity) / piece.ref.quantity : piece.ref.amount;
  }

  // A refund with an amount but no items (price gesture): spread over lines that still have money
  // left, as quantity-0 refunds (accepted by OR28 — confirmed live 2026-09-21, refund 6480).
  let gestureLeft = round2(payload.unallocatedAmount ?? 0);
  for (const [id, left] of remaining) {
    if (gestureLeft <= 0) break;
    const available = left.amount - (acc.get(id)?.amount ?? 0);
    const take = Math.min(gestureLeft, available);
    if (take <= 0) continue;
    const e = entry(id);
    e.amount += take;
    e.gesture = e.quantity === 0;
    gestureLeft = round2(gestureLeft - take);
  }
  if (gestureLeft > 0) problems.push(`${gestureLeft} ${currency} of the refund exceeds what Decathlon still holds for this order`);

  // Shipping refund: onto the lines being refunded first, then any line with shipping left.
  let shippingLeft = round2(payload.shippingAmount ?? 0);
  const shippingOrder = [...acc.keys(), ...[...remaining.keys()].filter((id) => !acc.has(id))];
  for (const id of shippingOrder) {
    if (shippingLeft <= 0) break;
    const take = Math.min(shippingLeft, remaining.get(id)?.shipping ?? 0);
    if (take <= 0) continue;
    entry(id).shipping += take;
    shippingLeft = round2(shippingLeft - take);
  }
  if (shippingLeft > 0) problems.push(`${shippingLeft} ${currency} of shipping refund exceeds the shipping Decathlon still holds`);

  const refunds: RefundInput[] = [];
  for (const [id, e] of acc) {
    const line = byId.get(id);
    const left = remaining.get(id);
    if (!line || !left) {
      problems.push(`${id} is not on the Decathlon order`);
      continue;
    }
    let amount = round2(e.amount);
    if (amount > left.amount) {
      problems.push(`${id}: capped ${amount} to the ${left.amount} Decathlon still holds`);
      amount = left.amount;
    }
    const shipping = round2(e.shipping);
    if (amount + shipping <= 0.01) continue;
    refunds.push({
      order_line_id: id,
      quantity: Math.min(e.quantity, Math.max(left.quantity, 0)),
      amount,
      shipping_amount: shipping,
      currency_iso_code: currency,
      reason_code: reasonFor(line, reasonOverride, e.gesture),
    });
  }
  return { refunds, problems };
}
