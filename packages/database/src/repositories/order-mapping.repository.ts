import type { MappingStatus, OrderLineItem, OrderMapping, PrismaClient } from "@prisma/client";
import type { NormalizedOrder } from "@shopify-decathlon/shared";

export class OrderMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  count(shopId: string): Promise<number> {
    return this.prisma.orderMapping.count({ where: { shopId } });
  }

  findByDecathlonOrderId(shopId: string, decathlonOrderId: string): Promise<OrderMapping | null> {
    return this.prisma.orderMapping.findUnique({
      where: { shopId_decathlonOrderId: { shopId, decathlonOrderId } },
    });
  }

  findByShopifyOrderId(shopId: string, shopifyOrderId: string): Promise<OrderMapping | null> {
    return this.prisma.orderMapping.findUnique({
      where: { shopId_shopifyOrderId: { shopId, shopifyOrderId } },
    });
  }

  /** The order plus its lines — the lines are what a fulfillment/refund maps onto. */
  findByShopifyOrderIdWithLines(shopId: string, shopifyOrderId: string): Promise<(OrderMapping & { lineItems: OrderLineItem[] }) | null> {
    return this.prisma.orderMapping.findUnique({
      where: { shopId_shopifyOrderId: { shopId, shopifyOrderId } },
      include: { lineItems: { include: { productMapping: true } } },
    });
  }

  findByCommercialId(shopId: string, decathlonCommercialId: string): Promise<OrderMapping | null> {
    return this.prisma.orderMapping.findFirst({ where: { shopId, decathlonCommercialId } });
  }

  /**
   * Rows imported before 2026-09-21 were keyed on the COMMERCIAL id (see the OrderMapping model).
   * Finding one under the commercial id means it's the same order: rekey it to the real `order_id`
   * so shipments and refunds address it correctly, instead of importing a duplicate Shopify order.
   */
  async repairLegacyId(shopId: string, orderId: string, commercialId: string): Promise<OrderMapping | null> {
    const legacy = await this.findByDecathlonOrderId(shopId, commercialId);
    if (!legacy || legacy.decathlonOrderId === orderId) return legacy;
    return this.prisma.orderMapping.update({
      where: { id: legacy.id },
      data: { decathlonOrderId: orderId, decathlonCommercialId: commercialId },
    });
  }

  rekey(id: string, decathlonOrderId: string, decathlonCommercialId: string): Promise<OrderMapping> {
    return this.prisma.orderMapping.update({ where: { id }, data: { decathlonOrderId, decathlonCommercialId } });
  }

  list(shopId: string, opts: { skip?: number; take?: number } = {}): Promise<OrderMapping[]> {
    return this.prisma.orderMapping.findMany({
      where: { shopId },
      skip: opts.skip,
      take: opts.take ?? 50,
      orderBy: { createdAt: "desc" },
      include: { lineItems: true },
    });
  }

  /**
   * The single mandatory dedup guard (requirement §13): callers MUST check this before creating
   * a Shopify order for a Decathlon order. The @@unique([shopId, decathlonOrderId]) constraint is
   * the last line of defense if two workers race.
   *
   * `matchStatus` and `productMappingByLineId` are caller-supplied (not hardcoded) because whether
   * every line matched a known ProductMapping is determined by the sync engine's matching pass
   * (docs/sync-strategy.md §1) before this is called — an order with any UNMATCHED line must stay
   * PENDING for manual resolution, never be recorded as SYNCED.
   */
  async createIfNotExists(
    shopId: string,
    shopifyOrderId: string,
    order: NormalizedOrder,
    opts: { matchStatus: MappingStatus; productMappingByLineId?: Map<string, string> } = { matchStatus: "PENDING" },
  ): Promise<{ mapping: OrderMapping; created: boolean }> {
    const existing = await this.findByDecathlonOrderId(shopId, order.externalId);
    if (existing) {
      return { mapping: existing, created: false };
    }

    try {
      const mapping = await this.prisma.orderMapping.create({
        data: {
          shopId,
          shopifyOrderId,
          decathlonOrderId: order.externalId,
          decathlonCommercialId: order.commercialId,
          decathlonOrderStatus: order.status,
          matchStatus: opts.matchStatus,
          lastSyncedAt: new Date(),
          lineItems: {
            create: order.items.map((item) => ({
              decathlonOrderLineId: item.decathlonOrderLineId,
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              currency: item.currency,
              taxAmount: item.taxAmount,
              discountAmount: item.discountAmount,
              productMappingId: opts.productMappingByLineId?.get(item.decathlonOrderLineId),
            })),
          },
        },
      });
      return { mapping, created: true };
    } catch (err) {
      // Unique constraint race: another worker created it between our check and our insert.
      const raced = await this.findByDecathlonOrderId(shopId, order.externalId);
      if (raced) return { mapping: raced, created: false };
      throw err;
    }
  }

  updateStatus(shopId: string, decathlonOrderId: string, decathlonOrderStatus: string): Promise<OrderMapping> {
    return this.prisma.orderMapping.update({
      where: { shopId_decathlonOrderId: { shopId, decathlonOrderId } },
      data: { decathlonOrderStatus, lastSyncedAt: new Date() },
    });
  }

  recordShipment(
    shopId: string,
    decathlonOrderId: string,
    decathlonShipmentId: string,
    shopifyFulfillmentId?: string,
  ): Promise<OrderMapping> {
    return this.prisma.orderMapping.update({
      where: { shopId_decathlonOrderId: { shopId, decathlonOrderId } },
      data: { decathlonShipmentId, shopifyFulfillmentId, lastSyncedAt: new Date() },
    });
  }
}
