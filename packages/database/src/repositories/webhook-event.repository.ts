import type { Prisma, PrismaClient, WebhookEvent } from "@prisma/client";

export class WebhookEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  record(shopId: string, topic: string, externalId: string | undefined, payload: Prisma.InputJsonValue): Promise<WebhookEvent> {
    return this.prisma.webhookEvent.create({
      data: { shopId, topic, externalId, payload, source: "SHOPIFY" },
    });
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
