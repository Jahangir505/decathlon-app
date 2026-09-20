import type { CatalogReferenceType, DecathlonCatalogReference, Prisma, PrismaClient } from "@prisma/client";

/**
 * Caches H11 (hierarchies) / PM11 (attributes) / VL11 (value lists) — endpoints Decathlon rate-limits
 * to ~1 call/hour (see docs/api-mapping.md §2.1). The product-import payload builder consults this
 * instead of calling those endpoints directly on every product sync.
 */
export class DecathlonCatalogReferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findFresh(
    shopId: string,
    type: CatalogReferenceType,
    key: string,
    maxAgeMs: number,
  ): Promise<DecathlonCatalogReference | null> {
    const row = await this.prisma.decathlonCatalogReference.findUnique({
      where: { shopId_type_key: { shopId, type, key } },
    });
    if (!row) return null;
    return Date.now() - row.fetchedAt.getTime() < maxAgeMs ? row : null;
  }

  upsert(
    shopId: string,
    type: CatalogReferenceType,
    key: string,
    data: Prisma.InputJsonValue,
  ): Promise<DecathlonCatalogReference> {
    return this.prisma.decathlonCatalogReference.upsert({
      where: { shopId_type_key: { shopId, type, key } },
      create: { shopId, type, key, data },
      update: { data, fetchedAt: new Date() },
    });
  }
}
