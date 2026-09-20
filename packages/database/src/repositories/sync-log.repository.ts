import type { Prisma, PrismaClient, SyncJobType, SyncLog, SyncStatus } from "@prisma/client";

export interface WriteSyncLogInput {
  shopId: string;
  syncJobId?: string;
  type: SyncJobType;
  status: SyncStatus;
  decathlonId?: string;
  shopifyId?: string;
  /** Product title + SKUs (or order id) — what the Sync Logs UI shows so a row names what it's about. */
  itemLabel?: string;
  requestSummary?: Prisma.InputJsonValue; // caller must have already masked secrets
  responseSummary?: Prisma.InputJsonValue; // caller must have already masked secrets
  httpStatus?: number;
  errorMessage?: string;
  retryCount?: number;
  durationMs?: number;
  correlationId: string;
}

export class SyncLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  write(input: WriteSyncLogInput): Promise<SyncLog> {
    return this.prisma.syncLog.create({ data: input });
  }

  /**
   * Terminal outcome of a submit-then-poll import (P41/OF01). The PROCESSING row written when the
   * import was submitted describes the SAME event, so it is resolved in place instead of appending
   * a second row — otherwise the Sync Logs UI shows a stale PROCESSING entry sitting next to its own
   * resolution forever, which reads as "still processing" long after the import finished.
   * Undefined fields are ignored by Prisma, so the submit-time requestSummary survives the update.
   */
  async resolvePending(input: WriteSyncLogInput): Promise<SyncLog> {
    const pending = await this.prisma.syncLog.findFirst({
      where: { shopId: input.shopId, correlationId: input.correlationId, type: input.type, status: "PROCESSING" },
      orderBy: { createdAt: "desc" },
    });
    if (!pending) return this.write(input);
    return this.prisma.syncLog.update({
      where: { id: pending.id },
      data: { ...input, itemLabel: input.itemLabel ?? pending.itemLabel ?? undefined },
    });
  }

  list(
    shopId: string,
    opts: { type?: SyncJobType; status?: SyncStatus; skip?: number; take?: number } = {},
  ): Promise<SyncLog[]> {
    return this.prisma.syncLog.findMany({
      where: { shopId, type: opts.type, status: opts.status },
      orderBy: { createdAt: "desc" },
      skip: opts.skip,
      take: opts.take ?? 50,
    });
  }

  count(shopId: string, opts: { type?: SyncJobType; status?: SyncStatus } = {}): Promise<number> {
    return this.prisma.syncLog.count({ where: { shopId, type: opts.type, status: opts.status } });
  }

  findByCorrelationId(shopId: string, correlationId: string): Promise<SyncLog[]> {
    return this.prisma.syncLog.findMany({ where: { shopId, correlationId } });
  }
}
