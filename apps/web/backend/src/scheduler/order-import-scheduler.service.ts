import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { Repositories } from "@shopify-decathlon/database";
import { REPOSITORIES } from "../database/database.module";
import { QueueProducerService } from "./queue-producer.service";

/**
 * Order import has no webhook to trigger off (Decathlon documents none, see docs/api-mapping.md §0)
 * — it has to be polled. BullMQ job schedulers are the actual per-shop pacing mechanism (survive
 * backend restarts, live in Redis); this service is what keeps that schedule in sync with
 * SyncConfiguration, since nothing else would notice when a shop's settings change. The 5-minute
 * sweep is a safety net — `reconcileShop` is also called directly right after a settings save, a
 * successful Decathlon connection test, and app uninstall, so changes normally take effect immediately.
 */
@Injectable()
export class OrderImportSchedulerService {
  private readonly logger = new Logger(OrderImportSchedulerService.name);

  constructor(
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
    private readonly queueProducer: QueueProducerService,
  ) {}

  @Cron("*/5 * * * *")
  async reconcileAll(): Promise<void> {
    const shops = await this.repositories.shops.listActive();
    for (const shop of shops) {
      try {
        await this.reconcileShop(shop.id);
      } catch (err) {
        this.logger.error(`reconcileShop failed for shop ${shop.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async reconcileShop(shopId: string): Promise<void> {
    const [config, connection] = await Promise.all([
      this.repositories.syncConfigurations.getOrCreateDefault(shopId),
      this.repositories.decathlonConnections.findByShopId(shopId),
    ]);

    const eligible = config.autoOrderImportEnabled && connection?.status === "CONNECTED";
    const desiredEveryMs = config.orderImportIntervalMinutes * 60_000;

    // The old repeatable entry never produced a job (see QueueProducerService.orderImportSchedulerId);
    // drop it wherever it's still sitting in Redis.
    await this.queueProducer.removeLegacyOrderImportRepeatable(shopId);

    const existing = await this.queueProducer.getOrderImportSchedule(shopId);

    if (!eligible) {
      if (existing) await this.queueProducer.removeOrderImportSchedule(shopId);
      return;
    }

    // Not upserting unconditionally: this runs every 5 minutes, and re-upserting an `every`
    // scheduler can reset its next run, which would keep pushing a 15-minute poll back forever.
    if (existing && existing.every === desiredEveryMs && existing.next) return;

    await this.queueProducer.upsertOrderImportSchedule(shopId, desiredEveryMs);
    this.logger.log(`order-import scheduled for shop ${shopId} every ${config.orderImportIntervalMinutes} min`);
  }

  async removeShopSchedule(shopId: string): Promise<void> {
    await this.queueProducer.removeOrderImportSchedule(shopId);
  }
}
