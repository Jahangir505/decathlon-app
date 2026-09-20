-- CreateEnum
CREATE TYPE "DecathlonEnvironment" AS ENUM ('PRODUCTION', 'PREPROD');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('NOT_CONFIGURED', 'CONNECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('UNMAPPED', 'PENDING', 'SYNCED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('PRODUCT_SYNC', 'OFFER_SYNC', 'ORDER_IMPORT', 'FULFILLMENT_SYNC', 'REFUND_SYNC', 'IMPORT_STATUS_POLL', 'RETRY_FAILED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING', 'SKIPPED', 'CANCELED');

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('SHOPIFY');

-- CreateEnum
CREATE TYPE "ApiTarget" AS ENUM ('SHOPIFY', 'DECATHLON');

-- CreateEnum
CREATE TYPE "CatalogReferenceType" AS ENUM ('HIERARCHY', 'ATTRIBUTE', 'VALUE_LIST');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopifyDomain" TEXT NOT NULL,
    "shopifyAccessToken" TEXT NOT NULL,
    "shopifyScope" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecathlonConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "environment" "DecathlonEnvironment" NOT NULL DEFAULT 'PREPROD',
    "baseUrl" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecathlonConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "ean" TEXT,
    "shopSku" TEXT NOT NULL,
    "decathlonProductId" TEXT,
    "decathlonOfferId" TEXT,
    "status" "MappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "decathlonOrderId" TEXT NOT NULL,
    "decathlonOrderStatus" TEXT NOT NULL,
    "shopifyOrderStatus" TEXT,
    "decathlonShipmentId" TEXT,
    "shopifyFulfillmentId" TEXT,
    "matchStatus" "MappingStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderMappingId" TEXT NOT NULL,
    "decathlonOrderLineId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT,
    "productMappingId" TEXT,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "taxAmount" DECIMAL(12,2),
    "discountAmount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderMappingId" TEXT NOT NULL,
    "decathlonReturnId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "rmaNumber" TEXT,
    "labelUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "bullJobId" TEXT,
    "payload" JSONB,
    "progressCurrent" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "syncJobId" TEXT,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "decathlonId" TEXT,
    "shopifyId" TEXT,
    "requestSummary" JSONB,
    "responseSummary" JSONB,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "source" "WebhookSource" NOT NULL DEFAULT 'SHOPIFY',
    "topic" TEXT NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "target" "ApiTarget" NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestHeadersMasked" JSONB,
    "requestBodyMasked" JSONB,
    "responseStatus" INTEGER,
    "responseBodyMasked" JSONB,
    "durationMs" INTEGER,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncConfiguration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "autoProductSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoOfferSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoOrderImportEnabled" BOOLEAN NOT NULL DEFAULT true,
    "orderImportIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "priceMarkupPercent" DECIMAL(5,2),
    "priceDiscountPercent" DECIMAL(5,2),
    "defaultCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "statusMapping" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecathlonCatalogReference" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "CatalogReferenceType" NOT NULL,
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecathlonCatalogReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyDomain_key" ON "Shop"("shopifyDomain");

-- CreateIndex
CREATE INDEX "Shop_shopifyDomain_idx" ON "Shop"("shopifyDomain");

-- CreateIndex
CREATE UNIQUE INDEX "DecathlonConnection_shopId_key" ON "DecathlonConnection"("shopId");

-- CreateIndex
CREATE INDEX "ProductMapping_shopId_sku_idx" ON "ProductMapping"("shopId", "sku");

-- CreateIndex
CREATE INDEX "ProductMapping_shopId_decathlonProductId_idx" ON "ProductMapping"("shopId", "decathlonProductId");

-- CreateIndex
CREATE INDEX "ProductMapping_shopId_status_idx" ON "ProductMapping"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shopId_shopifyVariantId_key" ON "ProductMapping"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "OrderMapping_shopId_decathlonOrderStatus_idx" ON "OrderMapping"("shopId", "decathlonOrderStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMapping_shopId_decathlonOrderId_key" ON "OrderMapping"("shopId", "decathlonOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMapping_shopId_shopifyOrderId_key" ON "OrderMapping"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderMappingId_idx" ON "OrderLineItem"("orderMappingId");

-- CreateIndex
CREATE INDEX "OrderLineItem_productMappingId_idx" ON "OrderLineItem"("productMappingId");

-- CreateIndex
CREATE INDEX "ReturnMapping_orderMappingId_idx" ON "ReturnMapping"("orderMappingId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnMapping_shopId_decathlonReturnId_key" ON "ReturnMapping"("shopId", "decathlonReturnId");

-- CreateIndex
CREATE INDEX "SyncJob_shopId_type_status_idx" ON "SyncJob"("shopId", "type", "status");

-- CreateIndex
CREATE INDEX "SyncLog_shopId_type_status_createdAt_idx" ON "SyncLog"("shopId", "type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncLog_correlationId_idx" ON "SyncLog"("correlationId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_topic_processed_idx" ON "WebhookEvent"("shopId", "topic", "processed");

-- CreateIndex
CREATE INDEX "WebhookEvent_externalId_idx" ON "WebhookEvent"("externalId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_shopId_target_createdAt_idx" ON "ApiRequestLog"("shopId", "target", "createdAt");

-- CreateIndex
CREATE INDEX "ApiRequestLog_correlationId_idx" ON "ApiRequestLog"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncConfiguration_shopId_key" ON "SyncConfiguration"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "DecathlonCatalogReference_shopId_type_key_key" ON "DecathlonCatalogReference"("shopId", "type", "key");

-- AddForeignKey
ALTER TABLE "DecathlonConnection" ADD CONSTRAINT "DecathlonConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderMapping" ADD CONSTRAINT "OrderMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderMappingId_fkey" FOREIGN KEY ("orderMappingId") REFERENCES "OrderMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productMappingId_fkey" FOREIGN KEY ("productMappingId") REFERENCES "ProductMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMapping" ADD CONSTRAINT "ReturnMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnMapping" ADD CONSTRAINT "ReturnMapping_orderMappingId_fkey" FOREIGN KEY ("orderMappingId") REFERENCES "OrderMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncLog" ADD CONSTRAINT "SyncLog_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "SyncJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncConfiguration" ADD CONSTRAINT "SyncConfiguration_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecathlonCatalogReference" ADD CONSTRAINT "DecathlonCatalogReference_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
