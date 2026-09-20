import type { AttributeValueMapping, CategoryMapping, PrismaClient } from "@prisma/client";
import { attributeValueKey } from "@shopify-decathlon/shared";

/** Shopify product types are free text and merchants are inconsistent about case/padding, so both
 *  sides of every lookup go through this rather than relying on exact stored casing. */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export class CategoryMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(shopId: string): Promise<CategoryMapping[]> {
    return this.prisma.categoryMapping.findMany({ where: { shopId }, orderBy: { shopifyProductType: "asc" } });
  }

  findByProductType(shopId: string, productType: string): Promise<CategoryMapping | null> {
    return this.prisma.categoryMapping.findUnique({
      where: { shopId_shopifyProductType: { shopId, shopifyProductType: normalizeKey(productType) } },
    });
  }

  upsert(
    shopId: string,
    shopifyProductType: string,
    decathlonCategoryCode: string,
    decathlonCategoryLabel?: string,
  ): Promise<CategoryMapping> {
    const key = normalizeKey(shopifyProductType);
    return this.prisma.categoryMapping.upsert({
      where: { shopId_shopifyProductType: { shopId, shopifyProductType: key } },
      create: { shopId, shopifyProductType: key, decathlonCategoryCode, decathlonCategoryLabel },
      update: { decathlonCategoryCode, decathlonCategoryLabel },
    });
  }

  async remove(shopId: string, shopifyProductType: string): Promise<void> {
    await this.prisma.categoryMapping.deleteMany({ where: { shopId, shopifyProductType: normalizeKey(shopifyProductType) } });
  }
}

export class AttributeValueMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(shopId: string, attributeCode?: string): Promise<AttributeValueMapping[]> {
    return this.prisma.attributeValueMapping.findMany({
      where: { shopId, attributeCode },
      orderBy: [{ attributeCode: "asc" }, { shopifyValue: "asc" }],
    });
  }

  /** One lookup per sync rather than one per variant-option — the import builder resolves a whole
   *  product's worth of option values against this map. */
  async mapFor(shopId: string, attributeCodes: string[]): Promise<Map<string, AttributeValueMapping>> {
    if (attributeCodes.length === 0) return new Map();
    const rows = await this.prisma.attributeValueMapping.findMany({
      where: { shopId, attributeCode: { in: attributeCodes } },
    });
    return new Map(rows.map((r) => [attributeValueKey(r.attributeCode, r.shopifyValue), r]));
  }

  upsert(
    shopId: string,
    input: { attributeCode: string; valuesListCode: string; shopifyValue: string; decathlonCode: string; decathlonLabel?: string },
  ): Promise<AttributeValueMapping> {
    const shopifyValue = normalizeKey(input.shopifyValue);
    const data = {
      valuesListCode: input.valuesListCode,
      decathlonCode: input.decathlonCode,
      decathlonLabel: input.decathlonLabel,
    };
    return this.prisma.attributeValueMapping.upsert({
      where: { shopId_attributeCode_shopifyValue: { shopId, attributeCode: input.attributeCode, shopifyValue } },
      create: { shopId, attributeCode: input.attributeCode, shopifyValue, ...data },
      update: data,
    });
  }

  async remove(shopId: string, attributeCode: string, shopifyValue: string): Promise<void> {
    await this.prisma.attributeValueMapping.deleteMany({
      where: { shopId, attributeCode, shopifyValue: normalizeKey(shopifyValue) },
    });
  }
}
