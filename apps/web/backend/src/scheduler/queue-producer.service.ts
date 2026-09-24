import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, type RepeatOptions } from "bullmq";
import IORedis from "ioredis";
import { decryptSecret, type AppEnv } from "@shopify-decathlon/shared";
import type { Repositories } from "@shopify-decathlon/database";
import {
  QUEUE_NAMES,
  DEFAULT_JOB_RETRY_OPTIONS,
  type ProductSyncJobPayload,
  type OfferSyncJobPayload,
  type OrderImportJobPayload,
  type FulfillmentSyncJobPayload,
  type RefundSyncJobPayload,
} from "@shopify-decathlon/sync";
import {
  ShopifyAdminGraphqlClient,
  PRODUCTS_PAGE_QUERY,
  PRODUCTS_BY_IDS_QUERY,
  effectiveProductType,
  fromGid,
  type ProductsPageResponse,
  type ProductsByIdsResponse,
} from "@shopify-decathlon/shopify";
import { APP_ENV } from "../config/config.module";
import { REPOSITORIES } from "../database/database.module";

/**
 * Owns the producer side of every BullMQ queue — the piece that was entirely missing from the
 * Phase 2 scaffold (the worker had Workers registered with nothing ever adding a job). Creates a
 * SyncJob row before enqueueing so the UI has something to show progress against immediately, and
 * uses deterministic jobIds so rapid duplicate webhook deliveries for the same product/variant
 * coalesce into one pending BullMQ job instead of piling up.
 */
@Injectable()
export class QueueProducerService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  onModuleInit(): void {
    this.connection = new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection?.quit();
  }

  private getQueue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * The deterministic job IDs below exist to coalesce duplicate *webhook* bursts (queue.add() with an
   * existing, still-pending job ID is a no-op, which is exactly what we want there) — but that same
   * behavior silently breaks manual retries: confirmed live, re-clicking "Sync products now" after a
   * product's first attempt already finished (completed OR failed — BullMQ's "completed" covers both,
   * since a caught ValidationError still resolves the job normally) returned success but queued
   * nothing, because BullMQ reused the old finished job under that ID instead of running a new one.
   * Removing a job that's already in a terminal state before re-adding fixes retries while leaving
   * in-flight coalescing (the original, still-needed behavior) untouched.
   */
  private async clearFinishedJob(queue: Queue, jobId: string): Promise<void> {
    const existing = await queue.getJob(jobId);
    if (!existing) return;
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.remove();
  }

  /**
   * `delayMs` is for webhook-triggered syncs: Shopify often sends several products/update webhooks
   * for one edit (e.g. again once an image finishes processing — seen live 2026-09-21, two imports
   * of the same product 8 minutes apart). While the delayed job is pending, later webhooks for the
   * same product hit the same job id and are dropped, so a burst becomes one import.
   */
  async enqueueProductSync(payload: ProductSyncJobPayload, opts: { delayMs?: number } = {}): Promise<void> {
    const queue = this.getQueue(QUEUE_NAMES.PRODUCT_SYNC);
    // fromGid, not the raw gid — BullMQ only allows a colon-containing custom Job ID when splitting
    // it on ":" gives exactly 3 parts (its own repeatable-job-key compatibility rule; confirmed live
    // by reading bullmq's Job.validateOptions source, error: "Custom Id cannot contain :"). A raw
    // Shopify gid ("gid://shopify/Product/123") adds its own colon, pushing a 3-part id like this
    // one past that limit. Never caught before now because this path had never actually been
    // exercised with a real product until "Sync products now" existed.
    const baseId = `product-sync:${payload.shopId}:${fromGid(payload.shopifyProductId)}`;
    await this.clearFinishedJob(queue, baseId);
    let jobId = baseId;
    const pending = await queue.getJob(baseId);
    if (pending) {
      // Waiting or delayed: that run hasn't read the product yet and will pick up this edit too.
      // Returning before the SyncJob row is written avoids a row BullMQ would never run.
      if ((await pending.getState()) !== "active") return;
      // Already running: it may have read the product before this edit, so queue ONE follow-up.
      jobId = `product-sync-next:${payload.shopId}:${fromGid(payload.shopifyProductId)}`;
      await this.clearFinishedJob(queue, jobId);
      if (await queue.getJob(jobId)) return;
    }
    const syncJob = await this.repositories.syncJobs.create(payload.shopId, "PRODUCT_SYNC", payload as object);
    const bullJob = await queue.add(
      "sync",
      { ...payload, syncJobId: syncJob.id },
      { ...DEFAULT_JOB_RETRY_OPTIONS, jobId, delay: opts.delayMs ?? 0 },
    );
    if (bullJob.id) await this.repositories.syncJobs.attachBullJobId(syncJob.id, bullJob.id);
  }

  /**
   * "Sync products now" (Connect Decathlon page) — the only way to publish a product today is a
   * reactive `products/update` webhook, gated by SyncConfiguration.autoProductSyncEnabled, which
   * means anything created/last-edited before that toggle was turned on never syncs on its own. This
   * walks every product in the shop — or, when productSyncScope is SELECTED, only the merchant's
   * picked list — and enqueues the ones that have a Decathlon category. Products missing one are
   * skipped here rather than enqueued to fail immediately (that per-product error is more useful
   * surfaced once, from the merchant explicitly fixing their metafield, than as N near-identical
   * SyncLog rows every time this runs).
   */
  async enqueueProductSyncAll(shopId: string): Promise<{ queued: number; skippedNoCategory: number }> {
    const config = await this.repositories.syncConfigurations.getOrCreateDefault(shopId);
    if (config.productSyncScope === "SELECTED") {
      const selected = await this.repositories.selectedProducts.list(shopId);
      return this.enqueueProductSyncForIds(shopId, selected.map((p) => p.shopifyProductId));
    }

    const shopify = await this.shopifyClient(shopId);
    const hasCategory = await this.categoryCheck(shopId);
    let queued = 0;
    let skippedNoCategory = 0;
    let cursor: string | null = null;
    do {
      const page: ProductsPageResponse = await shopify.request<ProductsPageResponse>(PRODUCTS_PAGE_QUERY, { cursor });
      for (const edge of page.products.edges) {
        // PRODUCTS_PAGE_QUERY already asks Shopify for status:active only; this guards the rule
        // locally too, so a change to that query can't quietly start importing drafts.
        if (edge.node.status !== "ACTIVE") continue;
        if (hasCategory(edge.node)) {
          await this.enqueueProductSync({ shopId, shopifyProductId: edge.node.id, trigger: "manual" });
          queued += 1;
        } else {
          skippedNoCategory += 1;
        }
      }
      cursor = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
    } while (cursor);

    return { queued, skippedNoCategory };
  }

  /** Same rules as enqueueProductSyncAll, for specific products (the SELECTED list, or products
   *  just added to it). Drafts, archived and deleted products are dropped silently. */
  async enqueueProductSyncForIds(shopId: string, productIds: string[]): Promise<{ queued: number; skippedNoCategory: number }> {
    if (productIds.length === 0) return { queued: 0, skippedNoCategory: 0 };
    const shopify = await this.shopifyClient(shopId);
    const hasCategory = await this.categoryCheck(shopId);
    let queued = 0;
    let skippedNoCategory = 0;
    for (let i = 0; i < productIds.length; i += 250) {
      const res = await shopify.request<ProductsByIdsResponse>(PRODUCTS_BY_IDS_QUERY, { ids: productIds.slice(i, i + 250) });
      for (const node of res.nodes) {
        if (!node || node.status !== "ACTIVE") continue;
        if (hasCategory(node)) {
          await this.enqueueProductSync({ shopId, shopifyProductId: node.id, trigger: "manual" });
          queued += 1;
        } else {
          skippedNoCategory += 1;
        }
      }
    }
    return { queued, skippedNoCategory };
  }

  private async shopifyClient(shopId: string): Promise<ShopifyAdminGraphqlClient> {
    const shop = await this.repositories.shops.findById(shopId);
    if (!shop) throw new Error(`shop ${shopId} not found`);
    return new ShopifyAdminGraphqlClient({
      shopDomain: shop.shopifyDomain,
      accessToken: decryptSecret(shop.shopifyAccessToken, this.env.ENCRYPTION_KEY),
      apiVersion: this.env.SHOPIFY_API_VERSION,
    });
  }

  /**
   * A product is eligible if it carries a per-product category metafield OR its Shopify product
   * type has a CategoryMapping rule — checking only the metafield (as this used to) silently
   * skipped every product covered by a rule, which is now the normal way categories are set.
   */
  private async categoryCheck(shopId: string) {
    const mappedProductTypes = new Set(
      (await this.repositories.categoryMappings.list(shopId)).map((m) => m.shopifyProductType),
    );
    return (node: ProductsPageResponse["products"]["edges"][number]["node"]) =>
      Boolean(node.decathlonCategory?.value) || mappedProductTypes.has(effectiveProductType(node).toLowerCase());
  }

  async enqueueOfferSync(payload: OfferSyncJobPayload): Promise<void> {
    const syncJob = await this.repositories.syncJobs.create(payload.shopId, "OFFER_SYNC", payload as object);
    const queue = this.getQueue(QUEUE_NAMES.OFFER_SYNC);
    // Same fromGid fix as enqueueProductSync above — same BullMQ ":" restriction applies here too.
    const jobId = `offer-sync:${payload.shopId}:${[...payload.shopifyVariantIds].map(fromGid).sort().join(",")}`;
    // Same finished-job-reuse fix as enqueueProductSync above — see clearFinishedJob's doc comment.
    await this.clearFinishedJob(queue, jobId);
    const bullJob = await queue.add("sync", { ...payload, syncJobId: syncJob.id }, { ...DEFAULT_JOB_RETRY_OPTIONS, jobId });
    if (bullJob.id) await this.repositories.syncJobs.attachBullJobId(syncJob.id, bullJob.id);
  }

  /**
   * A redelivered webhook maps to a job id BullMQ already holds, and BullMQ silently drops that
   * add(). Checking first matters because the SyncJob row is written before the add — without this
   * every redelivery left a row sitting on PENDING forever (seen live 2026-09-21 on a duplicate
   * refunds/create). The ShipmentMapping/RefundMapping claims remain the real double-send guard.
   */
  private async isKnownJob(queueName: string, jobId: string): Promise<boolean> {
    return Boolean(await this.getQueue(queueName).getJob(jobId));
  }

  /**
   * Keyed on the webhook delivery id: Shopify redelivers the same webhook with the same id, which
   * coalesces here, while a genuinely new `fulfillments/update` (tracking added later) gets its own
   * job. The ShipmentMapping claim is what actually prevents shipping the same lines twice.
   */
  async enqueueFulfillmentSync(payload: FulfillmentSyncJobPayload, webhookId: string): Promise<void> {
    const jobId = `fulfillment-sync:${payload.shopId}:${webhookId}`;
    if (await this.isKnownJob(QUEUE_NAMES.FULFILLMENT_SYNC, jobId)) return;
    const syncJob = await this.repositories.syncJobs.create(payload.shopId, "FULFILLMENT_SYNC", payload as object);
    const bullJob = await this.getQueue(QUEUE_NAMES.FULFILLMENT_SYNC).add(
      "sync",
      { ...payload, syncJobId: syncJob.id },
      { ...DEFAULT_JOB_RETRY_OPTIONS, jobId },
    );
    if (bullJob.id) await this.repositories.syncJobs.attachBullJobId(syncJob.id, bullJob.id);
  }

  /**
   * One job per Shopify refund, or per cancelled order. A cancellation is delayed so the
   * `refunds/create` Shopify sends for the same cancellation is pushed first — the cancel job then
   * only refunds what that refund left over, instead of both racing for the same balance (Decathlon
   * would refuse the loser, but as a confusing FAILED row).
   */
  async enqueueRefundSync(payload: RefundSyncJobPayload): Promise<void> {
    const jobId =
      payload.mode === "cancel"
        ? `refund-cancel:${payload.shopId}:${fromGid(payload.shopifyOrderId)}`
        : `refund-sync:${payload.shopId}:${payload.shopifyRefundId}`;
    if (await this.isKnownJob(QUEUE_NAMES.REFUND_SYNC, jobId)) return;
    const syncJob = await this.repositories.syncJobs.create(payload.shopId, "REFUND_SYNC", payload as object);
    const bullJob = await this.getQueue(QUEUE_NAMES.REFUND_SYNC).add(
      "sync",
      { ...payload, syncJobId: syncJob.id },
      { ...DEFAULT_JOB_RETRY_OPTIONS, jobId, delay: payload.mode === "cancel" ? 120_000 : 0 },
    );
    if (bullJob.id) await this.repositories.syncJobs.attachBullJobId(syncJob.id, bullJob.id);
  }

  /** Adds/updates the per-shop recurring order-import poll. `repeat.key` (not the deprecated
   *  `repeat.jobId`) is what gives the repeatable definition a stable identity BullMQ will actually
   *  return from getRepeatableJobs() — without it, every interval change leaves the old repeatable
   *  running forever alongside the new one instead of replacing it. */
  async enqueueOrderImportRepeatable(shopId: string, everyMs: number): Promise<void> {
    const repeat: RepeatOptions = { every: everyMs, key: `order-import:${shopId}` };
    await this.getQueue(QUEUE_NAMES.ORDER_IMPORT).add("poll", { shopId }, { repeat });
  }

  /** One-off, manually-triggered order-import run ("Sync now" in the UI) — separate from the
   *  repeatable poll so it runs immediately instead of waiting for the next scheduled tick. */
  async enqueueOrderImportNow(shopId: string): Promise<void> {
    const payload: OrderImportJobPayload = { shopId };
    const syncJob = await this.repositories.syncJobs.create(shopId, "ORDER_IMPORT", payload as object);
    const bullJob = await this.getQueue(QUEUE_NAMES.ORDER_IMPORT).add(
      "manual",
      { ...payload, syncJobId: syncJob.id },
      { ...DEFAULT_JOB_RETRY_OPTIONS, jobId: `order-import-manual:${shopId}:${Date.now()}` },
    );
    if (bullJob.id) await this.repositories.syncJobs.attachBullJobId(syncJob.id, bullJob.id);
  }

  async removeOrderImportRepeatable(shopId: string): Promise<void> {
    const queue = this.getQueue(QUEUE_NAMES.ORDER_IMPORT);
    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables.filter((r) => r.key === `order-import:${shopId}`)) {
      await queue.removeRepeatableByKey(r.key);
    }
  }

  getOrderImportRepeatables() {
    return this.getQueue(QUEUE_NAMES.ORDER_IMPORT).getRepeatableJobs();
  }
}
