import type { MappingStatus, PrismaClient, ProductMapping } from "@prisma/client";

export class ProductMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByVariant(shopId: string, shopifyVariantId: string): Promise<ProductMapping | null> {
    return this.prisma.productMapping.findUnique({
      where: { shopId_shopifyVariantId: { shopId, shopifyVariantId } },
    });
  }

  findBySku(shopId: string, sku: string): Promise<ProductMapping[]> {
    return this.prisma.productMapping.findMany({ where: { shopId, sku } });
  }

  /** Secondary match fallback per docs/sync-strategy.md §1 — never match on title. */
  findByEan(shopId: string, ean: string): Promise<ProductMapping[]> {
    return this.prisma.productMapping.findMany({ where: { shopId, ean } });
  }

  findByDecathlonProductId(shopId: string, decathlonProductId: string): Promise<ProductMapping[]> {
    return this.prisma.productMapping.findMany({ where: { shopId, decathlonProductId } });
  }

  list(
    shopId: string,
    opts: { status?: MappingStatus; skip?: number; take?: number } = {},
  ): Promise<ProductMapping[]> {
    return this.prisma.productMapping.findMany({
      where: { shopId, status: opts.status },
      skip: opts.skip,
      take: opts.take ?? 50,
      orderBy: { updatedAt: "desc" },
    });
  }

  /**
   * Upsert-by-variant so re-running a sync never creates a duplicate mapping row.
   *
   * `decathlonProductId`, when supplied, comes from a P31 duplicate-prevention lookup (see
   * matchProductMapping in packages/sync) that found this shop_sku already listed on Decathlon
   * before this app ever mapped it (e.g. created by another tool). Recording it immediately — not
   * waiting for the async P41 import's success report to resolve it by SKU — means the mapping is
   * correctly linked to the REAL existing Decathlon listing from the very first sync, so this app
   * never treats an already-listed product as brand new.
   */
  upsertForVariant(
    shopId: string,
    shopifyProductId: string,
    shopifyVariantId: string,
    data: { sku: string; ean?: string; shopSku: string; decathlonProductId?: string; lastPayloadHash?: string },
  ): Promise<ProductMapping> {
    const { decathlonProductId, ...rest } = data;
    return this.prisma.productMapping.upsert({
      where: { shopId_shopifyVariantId: { shopId, shopifyVariantId } },
      create: { shopId, shopifyProductId, shopifyVariantId, ...rest, decathlonProductId, status: "PENDING" },
      // Never overwrite an already-confirmed decathlonProductId with undefined on a re-sync; only
      // set it here if this call actually discovered one and the row doesn't have one yet.
      update: decathlonProductId ? { ...rest, decathlonProductId } : rest,
    });
  }

  markSynced(
    shopId: string,
    shopifyVariantId: string,
    decathlonProductId: string,
    decathlonOfferId?: string,
  ): Promise<ProductMapping> {
    return this.prisma.productMapping.update({
      where: { shopId_shopifyVariantId: { shopId, shopifyVariantId } },
      data: {
        decathlonProductId,
        decathlonOfferId,
        status: "SYNCED",
        lastSyncedAt: new Date(),
        lastError: null,
        retryCount: 0,
      },
    });
  }

  markFailed(shopId: string, shopifyVariantId: string, error: string): Promise<ProductMapping> {
    return this.prisma.productMapping.update({
      where: { shopId_shopifyVariantId: { shopId, shopifyVariantId } },
      data: { status: "FAILED", lastError: error, retryCount: { increment: 1 } },
    });
  }

  findByProducts(shopId: string, shopifyProductIds: string[]): Promise<ProductMapping[]> {
    return this.prisma.productMapping.findMany({ where: { shopId, shopifyProductId: { in: shopifyProductIds } } });
  }

  countByStatus(shopId: string) {
    return this.prisma.productMapping.groupBy({
      by: ["status"],
      where: { shopId },
      _count: { _all: true },
    });
  }
}
