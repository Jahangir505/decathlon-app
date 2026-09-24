import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Repositories } from "@shopify-decathlon/database";
import { REPOSITORIES } from "../database/database.module";
import { OrderImportSchedulerService } from "../scheduler/order-import-scheduler.service";
import { QueueProducerService } from "../scheduler/queue-producer.service";

export interface UpdateSyncConfigurationInput {
  autoProductSyncEnabled?: boolean;
  productSyncScope?: "ALL" | "SELECTED";
  autoOfferSyncEnabled?: boolean;
  autoOrderImportEnabled?: boolean;
  orderImportIntervalMinutes?: number;
  priceMarkupPercent?: number | null;
  priceDiscountPercent?: number | null;
  defaultCurrency?: string;
  manufacturerEmail?: string | null;
  fallbackBrandName?: string | null;
  refundReasonCode?: string | null;
  colorOptionName?: string | null;
  sizeOptionName?: string | null;
}

/** The only fields a settings save may write. The page posts back the whole row it loaded, and
 *  passing that through unfiltered also rewrote internal state — notably the order-import cursor,
 *  reset to whatever it was when the page was opened. */
const EDITABLE_FIELDS: Array<keyof UpdateSyncConfigurationInput> = [
  "autoProductSyncEnabled",
  "productSyncScope",
  "autoOfferSyncEnabled",
  "autoOrderImportEnabled",
  "orderImportIntervalMinutes",
  "priceMarkupPercent",
  "priceDiscountPercent",
  "defaultCurrency",
  "manufacturerEmail",
  "fallbackBrandName",
  "refundReasonCode",
  "colorOptionName",
  "sizeOptionName",
];

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

  /** The SELECTED-scope list, each with a rollup of its variants' Decathlon sync state. */
  async listSelectedProducts(shopId: string) {
    const selected = await this.repositories.selectedProducts.list(shopId);
    const mappings = await this.repositories.productMappings.findByProducts(shopId, selected.map((p) => p.shopifyProductId));
    return selected.map((p) => {
      const own = mappings.filter((m) => m.shopifyProductId === p.shopifyProductId);
      const status = own.some((m) => m.status === "FAILED")
        ? "FAILED"
        : own.some((m) => m.status === "PENDING")
          ? "PENDING"
          : own.length > 0 && own.every((m) => m.status === "SYNCED")
            ? "SYNCED"
            : "NOT_SYNCED";
      const lastSyncedAt = own.reduce<Date | null>((a, m) => (m.lastSyncedAt && (!a || m.lastSyncedAt > a) ? m.lastSyncedAt : a), null);
      return {
        shopifyProductId: p.shopifyProductId,
        title: p.title,
        addedAt: p.createdAt,
        status,
        lastSyncedAt,
        lastError: own.find((m) => m.status === "FAILED")?.lastError ?? null,
      };
    });
  }

  /** Adds products to the list and sends the new ones to Decathlon straight away — picking a
   *  product is the merchant saying "list this", so waiting for its next edit would surprise them. */
  async addSelectedProducts(shopId: string, products: Array<{ shopifyProductId: string; title: string }>) {
    const valid = (Array.isArray(products) ? products : []).filter(
      (p) => typeof p?.shopifyProductId === "string" && p.shopifyProductId.startsWith("gid://shopify/Product/"),
    );
    if (valid.length === 0) throw new BadRequestException("No valid products given");
    const added = await this.repositories.selectedProducts.addMany(
      shopId,
      valid.map((p) => ({ shopifyProductId: p.shopifyProductId, title: String(p.title ?? "").slice(0, 255) || "Untitled" })),
    );
    const connection = await this.repositories.decathlonConnections.findByShopId(shopId);
    const sync = connection
      ? await this.queueProducer.enqueueProductSyncForIds(shopId, added.map((p) => p.shopifyProductId))
      : { queued: 0, skippedNoCategory: 0 };
    return { added: added.length, ...sync };
  }

  /** Stops future syncs of the product. It is not delisted from Decathlon. */
  removeSelectedProduct(shopId: string, shopifyProductId: string) {
    return this.repositories.selectedProducts.remove(shopId, shopifyProductId);
  }

  /** Marks the setup wizard finished, so the app opens on the dashboard from then on. */
  async completeSetup(shopId: string) {
    await this.repositories.syncConfigurations.getOrCreateDefault(shopId);
    return this.repositories.syncConfigurations.update(shopId, { setupCompletedAt: new Date() });
  }

  /** Saves the toggles and immediately reconciles the order-import schedule — see
   *  OrderImportSchedulerService's doc comment for why this can't just wait for the 5-min sweep. */
  async update(shopId: string, input: UpdateSyncConfigurationInput) {
    await this.repositories.syncConfigurations.getOrCreateDefault(shopId); // ensure a row exists to update
    if (input.productSyncScope !== undefined && !["ALL", "SELECTED"].includes(input.productSyncScope)) {
      throw new BadRequestException("productSyncScope must be ALL or SELECTED");
    }
    const data = Object.fromEntries(EDITABLE_FIELDS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
    const updated = await this.repositories.syncConfigurations.update(shopId, data);
    await this.orderImportScheduler.reconcileShop(shopId);
    return updated;
  }
}
