import type { Prisma, PrismaClient, WebhookEvent } from "@prisma/client";

export class WebhookEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  record(shopId: string, topic: string, externalId: string | undefined, payload: Prisma.InputJsonValue): Promise<WebhookEvent> {
    return this.prisma.webhookEvent.create({
      data: { shopId, topic, externalId, payload, source: "SHOPIFY" },
    });
  }

  /**
   * GDPR `customers/redact`: stored webhook copies are the one place this app keeps customer
   * personal data (fulfillment payloads carry the delivery address; orders/cancelled carries the
   * whole order). Deletes every stored event for the given Shopify orders or customer. Order ids
   * sit under `order_id` (fulfillments, refunds) or, on order topics, the payload's own `id`.
   */
  async deleteForCustomer(shopId: string, orderIds: Array<number | string>, customerId?: number | string): Promise<number> {
    const ids = orderIds.map(String);
    return this.prisma.$executeRaw`
      DELETE FROM "WebhookEvent"
      WHERE "shopId" = ${shopId}
        AND (
          payload->>'order_id' = ANY(${ids}::text[])
          OR (topic LIKE 'orders/%' AND payload->>'id' = ANY(${ids}::text[]))
          OR (${customerId !== undefined} AND payload->'customer'->>'id' = ${String(customerId ?? "")})
        )`;
  }

  /** GDPR `customers/data_request`: how many stored events mention the customer's orders. */
  async countForCustomer(shopId: string, orderIds: Array<number | string>, customerId?: number | string): Promise<number> {
    const ids = orderIds.map(String);
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "WebhookEvent"
      WHERE "shopId" = ${shopId}
        AND (
          payload->>'order_id' = ANY(${ids}::text[])
          OR (topic LIKE 'orders/%' AND payload->>'id' = ANY(${ids}::text[]))
          OR (${customerId !== undefined} AND payload->'customer'->>'id' = ${String(customerId ?? "")})
        )`;
    return Number(rows[0]?.n ?? 0);
  }

  markProcessed(id: string, error?: string): Promise<WebhookEvent> {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: { processed: !error, processedAt: new Date(), error },
    });
  }

  listUnprocessed(shopId: string, topic?: string, take = 50): Promise<WebhookEvent[]> {
    return this.prisma.webhookEvent.findMany({
      where: { shopId, topic, processed: false },
      orderBy: { receivedAt: "asc" },
      take,
    });
  }
}
