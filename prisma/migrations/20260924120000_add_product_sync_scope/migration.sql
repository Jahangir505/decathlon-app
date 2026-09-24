-- CreateEnum
CREATE TYPE "ProductSyncScope" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "SyncConfiguration" ADD COLUMN     "productSyncScope" "ProductSyncScope" NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "SelectedProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SelectedProduct_shopId_shopifyProductId_key" ON "SelectedProduct"("shopId", "shopifyProductId");

-- AddForeignKey
ALTER TABLE "SelectedProduct" ADD CONSTRAINT "SelectedProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
