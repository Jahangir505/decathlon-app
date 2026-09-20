import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { Repositories } from "@shopify-decathlon/database";
import { REPOSITORIES } from "../database/database.module";
import { QueueProducerService } from "./queue-producer.service";

/**
 * Order import has no webhook to trigger off (Decathlon documents none, see docs/api-mapping.md §0)
 * — it has to be polled. BullMQ's repeatable jobs are the actual per-shop pacing mechanism (survive
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

    const repeatables = await this.queueProducer.getOrderImportRepeatables();
    const existing = repeatables.find((r) => r.key === `order-import:${shopId}`);

    if (!eligible) {
      if (existing) await this.queueProducer.removeOrderImportRepeatable(shopId);
      return;
    }

    if (existing && existing.every === String(desiredEveryMs)) {
      return; // already correct
    }

    if (existing) await this.queueProducer.removeOrderImportRepeatable(shopId);
    await this.queueProducer.enqueueOrderImportRepeatable(shopId, desiredEveryMs);
  }

  async removeShopSchedule(shopId: string): Promise<void> {
    await this.queueProducer.removeOrderImportRepeatable(shopId);
  }
}
