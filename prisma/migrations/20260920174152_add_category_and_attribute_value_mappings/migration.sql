-- CreateTable
CREATE TABLE "CategoryMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductType" TEXT NOT NULL,
    "decathlonCategoryCode" TEXT NOT NULL,
    "decathlonCategoryLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeValueMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "attributeCode" TEXT NOT NULL,
    "valuesListCode" TEXT NOT NULL,
    "shopifyValue" TEXT NOT NULL,
    "decathlonCode" TEXT NOT NULL,
    "decathlonLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeValueMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryMapping_shopId_idx" ON "CategoryMapping"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryMapping_shopId_shopifyProductType_key" ON "CategoryMapping"("shopId", "shopifyProductType");

-- CreateIndex
CREATE INDEX "AttributeValueMapping_shopId_attributeCode_idx" ON "AttributeValueMapping"("shopId", "attributeCode");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeValueMapping_shopId_attributeCode_shopifyValue_key" ON "AttributeValueMapping"("shopId", "attributeCode", "shopifyValue");

-- AddForeignKey
ALTER TABLE "CategoryMapping" ADD CONSTRAINT "CategoryMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeValueMapping" ADD CONSTRAINT "AttributeValueMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
