-- AlterEnum
ALTER TYPE "SyncJobType" ADD VALUE 'RETURN_SYNC';

-- AlterTable
ALTER TABLE "OrderMapping" ADD COLUMN     "decathlonCommercialId" TEXT;

-- AlterTable
ALTER TABLE "ReturnMapping" ADD COLUMN     "carrierCode" TEXT,
ADD COLUMN     "reasonCode" TEXT;

-- AlterTable
ALTER TABLE "SyncConfiguration" ADD COLUMN     "refundReasonCode" TEXT;

-- CreateTable
CREATE TABLE "ShipmentMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderMappingId" TEXT NOT NULL,
    "shopifyFulfillmentId" TEXT NOT NULL,
    "decathlonShipmentId" TEXT,
    "carrierCode" TEXT,
    "carrierName" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderMappingId" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "decathlonRefundIds" JSONB,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipmentMapping_orderMappingId_idx" ON "ShipmentMapping"("orderMappingId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentMapping_shopId_shopifyFulfillmentId_key" ON "ShipmentMapping"("shopId", "shopifyFulfillmentId");

-- CreateIndex
CREATE INDEX "RefundMapping_orderMappingId_idx" ON "RefundMapping"("orderMappingId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundMapping_shopId_shopifyRefundId_key" ON "RefundMapping"("shopId", "shopifyRefundId");

-- AddForeignKey
ALTER TABLE "ShipmentMapping" ADD CONSTRAINT "ShipmentMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentMapping" ADD CONSTRAINT "ShipmentMapping_orderMappingId_fkey" FOREIGN KEY ("orderMappingId") REFERENCES "OrderMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundMapping" ADD CONSTRAINT "RefundMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundMapping" ADD CONSTRAINT "RefundMapping_orderMappingId_fkey" FOREIGN KEY ("orderMappingId") REFERENCES "OrderMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;
