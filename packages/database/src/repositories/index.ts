import type { PrismaClient } from "@prisma/client";
import { ShopRepository } from "./shop.repository";
import { DecathlonConnectionRepository } from "./decathlon-connection.repository";
import { ProductMappingRepository } from "./product-mapping.repository";
import { OrderMappingRepository } from "./order-mapping.repository";
import { SyncJobRepository } from "./sync-job.repository";
import { SyncLogRepository } from "./sync-log.repository";
import { SyncConfigurationRepository } from "./sync-configuration.repository";
import { WebhookEventRepository } from "./webhook-event.repository";
import { DecathlonCatalogReferenceRepository } from "./decathlon-catalog-reference.repository";
import { AttributeValueMappingRepository, CategoryMappingRepository } from "./mapping-rules.repository";

export * from "./shop.repository";
export * from "./mapping-rules.repository";
export * from "./decathlon-connection.repository";
export * from "./product-mapping.repository";
export * from "./order-mapping.repository";
export * from "./sync-job.repository";
export * from "./sync-log.repository";
export * from "./sync-configuration.repository";
export * from "./webhook-event.repository";
export * from "./decathlon-catalog-reference.repository";

/** Convenience bundle so consumers construct one object instead of wiring each repository by hand. */
export function createRepositories(prisma: PrismaClient) {
  return {
    shops: new ShopRepository(prisma),
    decathlonConnections: new DecathlonConnectionRepository(prisma),
    productMappings: new ProductMappingRepository(prisma),
    orderMappings: new OrderMappingRepository(prisma),
    syncJobs: new SyncJobRepository(prisma),
    syncLogs: new SyncLogRepository(prisma),
    syncConfigurations: new SyncConfigurationRepository(prisma),
    webhookEvents: new WebhookEventRepository(prisma),
    catalogReferences: new DecathlonCatalogReferenceRepository(prisma),
    categoryMappings: new CategoryMappingRepository(prisma),
    attributeValueMappings: new AttributeValueMappingRepository(prisma),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
