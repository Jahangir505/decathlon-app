-- AlterTable
ALTER TABLE "SyncConfiguration" ADD COLUMN     "orderImportCursorDate" TIMESTAMP(3),
ADD COLUMN     "orderImportCursorOffset" INTEGER DEFAULT 0;
