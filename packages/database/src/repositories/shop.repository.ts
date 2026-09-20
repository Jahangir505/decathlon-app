import type { PrismaClient, Shop } from "@prisma/client";

/**
 * Shop is the one repository allowed to query without an existing shopId (it's how shopId is
 * discovered in the first place — via shopifyDomain, during OAuth/token-exchange).
 */
export class ShopRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByDomain(shopifyDomain: string): Promise<Shop | null> {
    return this.prisma.shop.findUnique({ where: { shopifyDomain } });
  }

  findById(shopId: string): Promise<Shop | null> {
    return this.prisma.shop.findUnique({ where: { id: shopId } });
  }

  /** Used by the order-import scheduler's reconciliation sweep (apps/web/backend/src/scheduler). */
  listActive(): Promise<Shop[]> {
    return this.prisma.shop.findMany({ where: { isActive: true } });
  }

  upsertByDomain(shopifyDomain: string, shopifyAccessToken: string, shopifyScope?: string): Promise<Shop> {
    return this.prisma.shop.upsert({
      where: { shopifyDomain },
      create: { shopifyDomain, shopifyAccessToken, shopifyScope, isActive: true },
      update: { shopifyAccessToken, shopifyScope, isActive: true, uninstalledAt: null },
    });
  }

  markUninstalled(shopifyDomain: string): Promise<Shop> {
    return this.prisma.shop.update({
      where: { shopifyDomain },
      data: { isActive: false, uninstalledAt: new Date() },
    });
  }

  markDecathlonCategoryMetafieldDefinitionCreated(shopId: string): Promise<Shop> {
    return this.prisma.shop.update({
      where: { id: shopId },
      data: { decathlonCategoryMetafieldDefinitionCreated: true },
    });
  }
}
