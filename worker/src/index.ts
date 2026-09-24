import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// The monorepo's single .env lives at the repo root, two levels up from this file's compiled
// location (worker/dist/index.js) — must run before loadEnv() reads process.env below.
loadDotenv({ path: resolve(__dirname, "../../.env") });

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { loadEnv } from "@shopify-decathlon/shared";
import { getPrismaClient, createRepositories } from "@shopify-decathlon/database";
import {
  SyncEngine,
  QUEUE_NAMES,
  DEFAULT_JOB_RETRY_OPTIONS,
  MAX_IMPORT_POLL_ATTEMPTS,
  importPollDelayMs,
  type ImportSubmission,
  type QueueName,
  type ProductSyncJobPayload,
  type OfferSyncJobPayload,
  type OrderImportJobPayload,
  type FulfillmentSyncJobPayload,
  type RefundSyncJobPayload,
  type ImportStatusPollJobPayload,
} from "@shopify-decathlon/sync";
import { createLogger } from "@shopify-decathlon/logger";
import { fromGid } from "@shopify-decathlon/shopify";
import { buildShopContext } from "./shop-context";

const env = loadEnv();
const logger = createLogger("worker");
const prisma = getPrismaClient();
const repositories = createRepositories(prisma);

// BullMQ requires maxRetriesPerRequest: null on the connection it uses for blocking commands.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Lazily-created Queue producers, used only for chaining follow-up jobs (e.g. product-sync success
// -> poll job, poll-terminal-success -> offer-sync job) — apps/web/backend owns the primary producer
// side (webhook-triggered and scheduled enqueues); this is purely worker-internal chaining.
const queues = new Map<string, Queue>();
function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

/**
 * One BullMQ Worker per queue, each wired to run the matching SyncEngine method against a
 * freshly-built per-shop context. Concurrency/rate limits below encode the per-endpoint ceilings
 * from docs/api-mapping.md — e.g. order-import must never exceed OR11's documented max frequency.
 * `onResult`, when given, lets a completed job chain the next one without teaching SyncEngine (or
 * packages/sync generally) anything about BullMQ — it stays queue-agnostic.
 */
function registerWorker<TPayload extends { shopId: string }, TResult>(
  queueName: string,
  concurrency: number,
  handler: (engine: SyncEngine, payload: TPayload) => Promise<TResult>,
  opts?: {
    limiter?: { max: number; duration: number };
    onResult?: (result: TResult, payload: TPayload, engine: SyncEngine) => Promise<void>;
  },
) {
  return new Worker(
    queueName,
    async (job) => {
      const shopId = job.data.shopId as string;
      const shopContext = await buildShopContext(
        shopId,
        repositories,
        env.ENCRYPTION_KEY,
        env.SHOPIFY_API_VERSION,
        logger,
      );
      const engine = new SyncEngine({
        repositories,
        decathlon: shopContext.decathlon,
        shopify: shopContext.shopify,
        logger,
      });

      logger.info({ event: "job_start", queue: queueName, jobId: job.id, shopId });
      try {
        const result = await handler(engine, job.data as TPayload);
        logger.info({ event: "job_success", queue: queueName, jobId: job.id, shopId });
        if (opts?.onResult) await opts.onResult(result, job.data as TPayload, engine);
      } catch (err) {
        logger.error({
          event: "job_failed",
          queue: queueName,
          jobId: job.id,
          shopId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // let BullMQ apply the queue's retry/backoff policy
      }
    },
    { connection, concurrency, limiter: opts?.limiter },
  );
}

/** Both import kinds hand off to the same poll chain — attempt 1, which re-queues itself as
 *  `poll_<importId>_<n>` from there (see the IMPORT_STATUS_POLL worker below). */
async function enqueueFirstPoll(shopId: string, result: ImportSubmission): Promise<void> {
  await getQueue(QUEUE_NAMES.IMPORT_STATUS_POLL).add(
    "poll",
    {
      shopId,
      importId: result.importId,
      kind: result.kind,
      shopifyVariantIds: result.shopifyVariantIds,
      correlationId: result.correlationId,
      syncJobId: result.syncJobId,
      itemLabel: result.itemLabel,
      pollAttempt: 1,
    } satisfies ImportStatusPollJobPayload,
    { ...DEFAULT_JOB_RETRY_OPTIONS, jobId: `poll_${result.importId}_1`, delay: 30_000, removeOnComplete: true },
  );
}

registerWorker(QUEUE_NAMES.PRODUCT_SYNC, 5, (engine, payload: ProductSyncJobPayload) => engine.syncProduct(payload), {
  onResult: async (result, payload) => {
    if (!result) return;
    if ("unchanged" in result) {
      // No product import was needed, but products/update is also how a Shopify PRICE change
      // arrives — so still refresh price & stock for whatever is already live on Decathlon.
      if (result.liveVariantIds.length === 0) return;
      await getQueue(QUEUE_NAMES.OFFER_SYNC).add(
        "sync",
        { shopId: payload.shopId, shopifyVariantIds: result.liveVariantIds, correlationId: result.correlationId } satisfies OfferSyncJobPayload,
        { ...DEFAULT_JOB_RETRY_OPTIONS, jobId: `offer-sync:${payload.shopId}:${[...result.liveVariantIds].map(fromGid).sort().join(",")}` },
      );
      return;
    }
    await enqueueFirstPoll(payload.shopId, result);
  },
});

registerWorker(QUEUE_NAMES.OFFER_SYNC, 5, (engine, payload: OfferSyncJobPayload) => engine.syncOffers(payload), {
  onResult: async (result, payload) => {
    if (!result) return;
    await enqueueFirstPoll(payload.shopId, result);
  },
});

// OR11 max usage: once/min (default tier) — see docs/api-mapping.md §2.4. One order-import job per
// shop is enqueued on a schedule (see apps/web/backend's SchedulerModule), so concurrency=1 plus
// this limiter is a defense-in-depth ceiling, not the primary pacing mechanism.
// Returns (RT11) ride along on the same schedule: there's no webhook for them either, and a return
// only matters for an order this job has already imported. A returns failure must not fail the
// order import, which is the part that has a customer waiting.
registerWorker(
  QUEUE_NAMES.ORDER_IMPORT,
  1,
  async (engine, payload: OrderImportJobPayload) => {
    await engine.importOrders(payload);
    try {
      await engine.syncReturns({ shopId: payload.shopId, correlationId: payload.correlationId });
    } catch (err) {
      logger.error({ event: "return_sync_failed", shopId: payload.shopId, error: err instanceof Error ? err.message : String(err) });
    }
  },
  { limiter: { max: 1, duration: 60_000 } },
);

// Concurrency 1 for both: two jobs for the same order (e.g. a cancellation and its refund arriving
// together) must not read Decathlon's "still refundable" figures at the same time.
registerWorker(QUEUE_NAMES.FULFILLMENT_SYNC, 1, (engine, payload: FulfillmentSyncJobPayload) => engine.syncFulfillment(payload));
registerWorker(QUEUE_NAMES.REFUND_SYNC, 1, (engine, payload: RefundSyncJobPayload) => engine.syncRefund(payload));

// Fills the Phase 2 scaffold's gap: P41/OF01 are async submit-then-poll, and nothing previously
// polled. Re-adds itself with a delay while PENDING; chains into offer-sync once a product import
// terminates successfully.
const importStatusPollWorker = registerWorker(QUEUE_NAMES.IMPORT_STATUS_POLL, 3, (engine, payload: ImportStatusPollJobPayload) => engine.pollImportStatus(payload), {
  onResult: async (result, payload, engine) => {
    if (result.status === "PENDING") {
      const attempt = (payload.pollAttempt ?? 1) + 1;
      if (attempt > MAX_IMPORT_POLL_ATTEMPTS) {
        await engine.failStalledImport({ ...payload, pollAttempt: attempt - 1 });
        return;
      }
      // The job id MUST differ from the one currently running. onResult is called from inside the
      // processor, so this job is still `active` — and BullMQ silently drops an add() whose jobId
      // already exists, in any state. Re-adding under the same `poll_<importId>` therefore did
      // nothing at all (confirmed live 2026-09-20: Redis emitted a `duplicated` event for
      // poll_26737 and no new job), so an import that wasn't finished on its first check was never
      // checked again and its SyncLog sat on PROCESSING forever. The attempt suffix keeps the id
      // unique per attempt while still preventing two concurrent polls of the same attempt.
      await getQueue(QUEUE_NAMES.IMPORT_STATUS_POLL).add(
        "poll",
        { ...payload, pollAttempt: attempt },
        {
          ...DEFAULT_JOB_RETRY_OPTIONS,
          jobId: `poll_${payload.importId}_${attempt}`,
          delay: importPollDelayMs(attempt),
          removeOnComplete: true,
        },
      );
      return;
    }
    if (result.result === "SUCCESS" && result.kind === "product") {
      await getQueue(QUEUE_NAMES.OFFER_SYNC).add(
        "sync",
        { shopId: result.shopId, shopifyVariantIds: result.shopifyVariantIds, correlationId: result.correlationId },
        // fromGid — same BullMQ jobId restriction as everywhere else this pattern appears (a raw
        // Shopify gid's colon pushes the id past BullMQ's "exactly 3 parts when colon-containing"
        // rule; confirmed live 2026-09-18, see queue-producer.service.ts's identical fix).
        { ...DEFAULT_JOB_RETRY_OPTIONS, jobId: `offer-sync:${result.shopId}:${[...result.shopifyVariantIds].map(fromGid).sort().join(",")}` },
      );
    }
  },
});

/**
 * A poll job is the ONLY thing that can move a submitted import's SyncLog off PROCESSING, so if one
 * dies for good the row is stranded exactly as if the chain had never been scheduled. Retries above
 * cover transient failures; this covers the rest, closing the loop so a PROCESSING row always
 * resolves one way or another rather than being indistinguishable from "still working".
 */
importStatusPollWorker.on("failed", async (job, err) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const payload = job.data as ImportStatusPollJobPayload;
  logger.error({ event: "import_poll_exhausted", shopId: payload.shopId, importId: payload.importId, error: String(err) });
  try {
    const shopContext = await buildShopContext(payload.shopId, repositories, env.ENCRYPTION_KEY, env.SHOPIFY_API_VERSION, logger);
    const engine = new SyncEngine({ repositories, decathlon: shopContext.decathlon, shopify: shopContext.shopify, logger });
    await engine.failStalledImport(payload);
  } catch (resolveErr) {
    logger.error({ event: "import_poll_exhausted_resolve_failed", shopId: payload.shopId, error: String(resolveErr) });
  }
});

/**
 * Minimal retry-failed-sync sweep (docs/architecture.md §9) — given {shopId, syncJobId}, re-enqueues
 * that job's original payload onto its original queue. Does NOT build a ShopContext/SyncEngine (no
 * Decathlon/Shopify calls happen here), so it's a plain Worker, not registerWorker.
 */
const JOB_TYPE_TO_QUEUE: Record<string, QueueName> = {
  PRODUCT_SYNC: QUEUE_NAMES.PRODUCT_SYNC,
  OFFER_SYNC: QUEUE_NAMES.OFFER_SYNC,
  ORDER_IMPORT: QUEUE_NAMES.ORDER_IMPORT,
  FULFILLMENT_SYNC: QUEUE_NAMES.FULFILLMENT_SYNC,
  REFUND_SYNC: QUEUE_NAMES.REFUND_SYNC,
  IMPORT_STATUS_POLL: QUEUE_NAMES.IMPORT_STATUS_POLL,
};

new Worker(
  QUEUE_NAMES.RETRY_FAILED_SYNC,
  async (job) => {
    const { shopId, syncJobId } = job.data as { shopId: string; syncJobId: string };
    const syncJob = await repositories.syncJobs.findById(shopId, syncJobId);
    if (!syncJob) {
      logger.warn({ event: "retry_failed_sync_missing_job", shopId, syncJobId });
      return;
    }
    const targetQueue = JOB_TYPE_TO_QUEUE[syncJob.type];
    if (!targetQueue) {
      logger.warn({ event: "retry_failed_sync_unknown_type", shopId, syncJobId, type: syncJob.type });
      return;
    }
    await repositories.syncJobs.markRetrying(syncJobId);
    await getQueue(targetQueue).add(targetQueue, syncJob.payload as object, {
      ...DEFAULT_JOB_RETRY_OPTIONS,
      jobId: `retry:${syncJobId}:${Date.now()}`,
    });
    logger.info({ event: "retry_failed_sync_requeued", shopId, syncJobId, targetQueue });
  },
  { connection, concurrency: 1 },
);

logger.info({ event: "worker_started", queues: Object.values(QUEUE_NAMES) });

process.on("SIGTERM", async () => {
  logger.info({ event: "worker_shutdown" });
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
});
