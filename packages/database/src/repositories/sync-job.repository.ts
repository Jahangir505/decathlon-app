import type { Prisma, PrismaClient, SyncJob, SyncJobType, SyncStatus } from "@prisma/client";

export class SyncJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(shopId: string, type: SyncJobType, payload?: Prisma.InputJsonValue): Promise<SyncJob> {
    return this.prisma.syncJob.create({
      data: { shopId, type, payload, status: "PENDING" },
    });
  }

  attachBullJobId(id: string, bullJobId: string): Promise<SyncJob> {
    return this.prisma.syncJob.update({ where: { id }, data: { bullJobId } });
  }

  start(id: string): Promise<SyncJob> {
    return this.prisma.syncJob.update({
      where: { id },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
  }

  updateProgress(id: string, current: number, total?: number): Promise<SyncJob> {
    return this.prisma.syncJob.update({
      where: { id },
      data: { progressCurrent: current, progressTotal: total },
    });
  }

  finish(id: string, status: Extract<SyncStatus, "SUCCESS" | "FAILED" | "SKIPPED" | "CANCELED">, error?: string): Promise<SyncJob> {
    return this.prisma.syncJob.update({
      where: { id },
      data: { status, finishedAt: new Date(), lastError: error },
    });
  }

  /** Marks a job as scheduled for another attempt — used by the retry-failed-sync sweep. */
  markRetrying(id: string): Promise<SyncJob> {
    return this.prisma.syncJob.update({
      where: { id },
      data: { status: "RETRYING", retryCount: { increment: 1 } },
    });
  }

  findById(shopId: string, id: string): Promise<SyncJob | null> {
    return this.prisma.syncJob.findFirst({ where: { id, shopId } });
  }

  list(shopId: string, opts: { type?: SyncJobType; status?: SyncStatus; take?: number } = {}): Promise<SyncJob[]> {
    return this.prisma.syncJob.findMany({
      where: { shopId, type: opts.type, status: opts.status },
      orderBy: { createdAt: "desc" },
      take: opts.take ?? 50,
    });
  }
}
