import type { Prisma, PrismaClient, RefundMapping, ReturnMapping, ShipmentMapping, SyncStatus } from "@prisma/client";

/** Shopify fulfillment <-> Decathlon shipment (ST01). See the ShipmentMapping model. */
export class ShipmentMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByFulfillment(shopId: string, shopifyFulfillmentId: string): Promise<ShipmentMapping | null> {
    return this.prisma.shipmentMapping.findUnique({ where: { shopId_shopifyFulfillmentId: { shopId, shopifyFulfillmentId } } });
  }

  /**
   * Claims a fulfillment before anything is sent to Decathlon — the unique key makes two concurrent
   * deliveries of the same webhook race on this insert rather than both shipping the lines.
   * Returns null when the row already exists and isn't FAILED (a FAILED one is reclaimed for retry).
   */
  async claim(shopId: string, orderMappingId: string, shopifyFulfillmentId: string): Promise<ShipmentMapping | null> {
    try {
      return await this.prisma.shipmentMapping.create({ data: { shopId, orderMappingId, shopifyFulfillmentId, status: "PROCESSING" } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      const reclaimed = await this.prisma.shipmentMapping.updateMany({
        where: { shopId, shopifyFulfillmentId, status: "FAILED" },
        data: { status: "PROCESSING", lastError: null },
      });
      return reclaimed.count > 0 ? this.findByFulfillment(shopId, shopifyFulfillmentId) : null;
    }
  }

  update(id: string, data: Prisma.ShipmentMappingUpdateInput): Promise<ShipmentMapping> {
    return this.prisma.shipmentMapping.update({ where: { id }, data });
  }
}

/** Shopify refund <-> OR28 call. See the RefundMapping model. */
export class RefundMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByShopifyRefund(shopId: string, shopifyRefundId: string): Promise<RefundMapping | null> {
    return this.prisma.refundMapping.findUnique({ where: { shopId_shopifyRefundId: { shopId, shopifyRefundId } } });
  }

  /** Same claim-before-send contract as ShipmentMappingRepository.claim — a refund must never be
   *  issued twice. A FAILED row may be reclaimed so a retry can go through. */
  async claim(shopId: string, orderMappingId: string, shopifyRefundId: string): Promise<RefundMapping | null> {
    try {
      return await this.prisma.refundMapping.create({ data: { shopId, orderMappingId, shopifyRefundId, status: "PROCESSING" } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      const reclaimed = await this.prisma.refundMapping.updateMany({
        where: { shopId, shopifyRefundId, status: "FAILED" },
        data: { status: "PROCESSING", lastError: null },
      });
      return reclaimed.count > 0 ? this.findByShopifyRefund(shopId, shopifyRefundId) : null;
    }
  }

  finish(
    id: string,
    status: SyncStatus,
    data: { decathlonRefundIds?: Prisma.InputJsonValue; amount?: number; currency?: string; lastError?: string | null } = {},
  ): Promise<RefundMapping> {
    return this.prisma.refundMapping.update({ where: { id }, data: { status, ...data } });
  }
}

/** Decathlon returns (RT11), mirrored locally so state changes can be detected between polls. */
export class ReturnMappingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByDecathlonReturnId(shopId: string, decathlonReturnId: string): Promise<ReturnMapping | null> {
    return this.prisma.returnMapping.findUnique({ where: { shopId_decathlonReturnId: { shopId, decathlonReturnId } } });
  }

  upsert(
    shopId: string,
    orderMappingId: string,
    decathlonReturnId: string,
    data: { status: string; reasonCode?: string; rmaNumber?: string; trackingNumber?: string; carrierCode?: string },
  ): Promise<ReturnMapping> {
    return this.prisma.returnMapping.upsert({
      where: { shopId_decathlonReturnId: { shopId, decathlonReturnId } },
      create: { shopId, orderMappingId, decathlonReturnId, ...data },
      update: data,
    });
  }

  /** Returns Decathlon may still move — re-checked every poll, since RT11 can only be sorted by
   *  creation date and a state change on an older return would otherwise never be seen. */
  listOpen(shopId: string, terminalStates: string[], take = 50) {
    return this.prisma.returnMapping.findMany({
      where: { shopId, status: { notIn: terminalStates } },
      include: { orderMapping: true },
      orderBy: { updatedAt: "asc" },
      take,
    });
  }

  listForShop(shopId: string, opts: { skip?: number; take?: number } = {}) {
    return this.prisma.returnMapping.findMany({
      where: { shopId },
      include: { orderMapping: { select: { shopifyOrderId: true, decathlonOrderId: true, decathlonCommercialId: true } } },
      orderBy: { createdAt: "desc" },
      skip: opts.skip,
      take: opts.take ?? 50,
    });
  }
}
