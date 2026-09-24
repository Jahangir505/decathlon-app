import type { PrismaClient, SelectedProduct } from "@prisma/client";

export class SelectedProductRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(shopId: string): Promise<SelectedProduct[]> {
    return this.prisma.selectedProduct.findMany({ where: { shopId }, orderBy: { createdAt: "desc" } });
  }

  async isSelected(shopId: string, shopifyProductId: string): Promise<boolean> {
    const row = await this.prisma.selectedProduct.findUnique({
      where: { shopId_shopifyProductId: { shopId, shopifyProductId } },
      select: { id: true },
    });
    return Boolean(row);
  }

  /** Adds the products not already on the list; returns only the newly added ones. */
  async addMany(shopId: string, products: Array<{ shopifyProductId: string; title: string }>): Promise<SelectedProduct[]> {
    const existing = new Set(
      (
        await this.prisma.selectedProduct.findMany({
          where: { shopId, shopifyProductId: { in: products.map((p) => p.shopifyProductId) } },
          select: { shopifyProductId: true },
        })
      ).map((r) => r.shopifyProductId),
    );
    const fresh = products.filter((p) => !existing.has(p.shopifyProductId));
    await this.prisma.selectedProduct.createMany({ data: fresh.map((p) => ({ shopId, ...p })), skipDuplicates: true });
    return this.prisma.selectedProduct.findMany({
      where: { shopId, shopifyProductId: { in: fresh.map((p) => p.shopifyProductId) } },
    });
  }

  async remove(shopId: string, shopifyProductId: string): Promise<void> {
    await this.prisma.selectedProduct.deleteMany({ where: { shopId, shopifyProductId } });
  }
}
