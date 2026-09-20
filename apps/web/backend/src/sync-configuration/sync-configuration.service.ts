import { Inject, Injectable } from "@nestjs/common";
import type { Repositories } from "@shopify-decathlon/database";
import { REPOSITORIES } from "../database/database.module";
import { OrderImportSchedulerService } from "../scheduler/order-import-scheduler.service";
import { QueueProducerService } from "../scheduler/queue-producer.service";

export interface UpdateSyncConfigurationInput {
  autoProductSyncEnabled?: boolean;
  autoOfferSyncEnabled?: boolean;
  autoOrderImportEnabled?: boolean;
  orderImportIntervalMinutes?: number;
  priceMarkupPercent?: number | null;
  priceDiscountPercent?: number | null;
  defaultCurrency?: string;
  manufacturerEmail?: string | null;
  fallbackBrandName?: string | null;
}

@Injectable()
export class SyncConfigurationService {
  constructor(
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
    private readonly orderImportScheduler: OrderImportSchedulerService,
    private readonly queueProducer: QueueProducerService,
  ) {}

  get(shopId: string) {
    return this.repositories.syncConfigurations.getOrCreateDefault(shopId);
  }

  syncOrdersNow(shopId: string) {
    return this.queueProducer.enqueueOrderImportNow(shopId);
  }

  syncProductsNow(shopId: string) {
    return this.queueProducer.enqueueProductSyncAll(shopId);
  }

  /** Saves the toggles and immediately reconciles the order-import schedule — see
   *  OrderImportSchedulerService's doc comment for why this can't just wait for the 5-min sweep. */
  async update(shopId: string, input: UpdateSyncConfigurationInput) {
    await this.repositories.syncConfigurations.getOrCreateDefault(shopId); // ensure a row exists to update
    const updated = await this.repositories.syncConfigurations.update(shopId, input);
    await this.orderImportScheduler.reconcileShop(shopId);
    return updated;
  }
}
