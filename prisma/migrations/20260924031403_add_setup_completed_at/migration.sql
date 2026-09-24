-- AlterTable
ALTER TABLE "SyncConfiguration" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3);

-- Shops that were already connected before the wizard existed count as set up.
UPDATE "SyncConfiguration" sc SET "setupCompletedAt" = NOW()
WHERE EXISTS (SELECT 1 FROM "DecathlonConnection" dc WHERE dc."shopId" = sc."shopId");
