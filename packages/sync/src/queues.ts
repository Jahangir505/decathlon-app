/**
 * Queue names and job payload contracts shared between the backend (enqueues) and the worker
 * (processes). See docs/architecture.md §9 for what each queue does and its trigger.
 */
export const QUEUE_NAMES = {
  PRODUCT_SYNC: "product-sync",
  OFFER_SYNC: "offer-sync",
  ORDER_IMPORT: "order-import",
  FULFILLMENT_SYNC: "fulfillment-sync",
  REFUND_SYNC: "refund-sync",
  IMPORT_STATUS_POLL: "import-status-poll",
  RETRY_FAILED_SYNC: "retry-failed-sync",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ProductSyncJobPayload {
  shopId: string;
  shopifyProductId: string;
  shopifyVariantIds?: string[]; // omit to sync all variants of the product
  correlationId?: string;
  syncJobId?: string;
}

export interface OfferSyncJobPayload {
  shopId: string;
  shopifyVariantIds: string[];
  correlationId?: string;
  syncJobId?: string;
}

export interface OrderImportJobPayload {
  shopId: string;
  correlationId?: string;
  syncJobId?: string;
}

export interface FulfillmentSyncJobPayload {
  shopId: string;
  shopifyOrderId: string;
  shopifyFulfillmentId: string;
}

export interface RefundSyncJobPayload {
  shopId: string;
  shopifyOrderId: string;
}

export interface ImportStatusPollJobPayload {
  shopId: string;
  importId: string;
  kind: "product" | "offer";
  shopifyVariantIds: string[];
  correlationId?: string;
  syncJobId?: string;
  /** Human-readable name of what is being imported, carried through so the terminal SyncLog can say
   *  which product it was about rather than showing a row of empty id columns. */
  itemLabel?: string;
  /** 1-based; incremented on every re-poll. The worker uses it both to build a unique BullMQ job id
   *  per attempt and to stop polling after MAX_IMPORT_POLL_ATTEMPTS. */
  pollAttempt?: number;
}

/**
 * How many times an import is polled before giving up and failing the job with a timeout message —
 * the backstop that guarantees a SyncLog always eventually leaves PROCESSING. Paired with the
 * backoff below this spans ~19 hours, deliberately long: how soon Decathlon runs a product import's
 * integration stage is NOT known (an import observed on 2026-09-20 was still `SENT` 20 minutes in,
 * while day-old ones had all integrated), so the ceiling is set to survive an overnight batch.
 * Giving up early would report a still-running import as failed, which is worse than waiting.
 */
export const MAX_IMPORT_POLL_ATTEMPTS = 60;

/**
 * Delay before the next status check. Offer imports resolve in well under a minute, so early
 * attempts stay fast for quick feedback; a PRODUCT import's second (integration) stage is far
 * slower — CONFIRMED live 2026-09-20, an import sat at `import_status: "SENT"` through 11
 * consecutive checks — so later attempts back off hard. A status GET is cheap; the point of backing
 * off is to not poll an endpoint that changes on the order of hours once per minute for a day.
 * Total window: 10x1min + 15x5min + 35x30min ≈ 19 hours.
 */
export function importPollDelayMs(attempt: number): number {
  if (attempt <= 10) return 60_000;
  if (attempt <= 25) return 300_000;
  return 1_800_000;
}

export interface RetryFailedSyncJobPayload {
  shopId: string;
  syncJobId: string;
}

/**
 * BullMQ job-level attempts/backoff — a second line of defense for whole-job failures (crash, DB
 * write failure, network partition) that occur after packages/decathlon's own HTTP-layer retries
 * (2s->4s->8s->16s->32s, 5 attempts, see http-client.ts) are already exhausted. Deliberately not the
 * same sequence — this is a coarser, cheaper backstop, not a duplicate of the HTTP-layer policy.
 * Plain object (no bullmq dependency here) — spread into `queue.add(name, payload, {...})` by the
 * producer in apps/web/backend.
 */
export interface JobRetryOptions {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
}

export const DEFAULT_JOB_RETRY_OPTIONS: JobRetryOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
};
