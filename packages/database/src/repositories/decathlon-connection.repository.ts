import type { ConnectionStatus, DecathlonConnection, DecathlonEnvironment, Prisma, PrismaClient } from "@prisma/client";

export class DecathlonConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByShopId(shopId: string): Promise<DecathlonConnection | null> {
    return this.prisma.decathlonConnection.findUnique({ where: { shopId } });
  }

  upsert(
    shopId: string,
    data: { apiKeyEncrypted: string; environment: DecathlonEnvironment; baseUrl: string },
  ): Promise<DecathlonConnection> {
    return this.prisma.decathlonConnection.upsert({
      where: { shopId },
      create: { shopId, ...data, status: "NOT_CONFIGURED" },
      update: data,
    });
  }

  recordTestResult(
    shopId: string,
    status: ConnectionStatus,
    result: Prisma.InputJsonValue,
  ): Promise<DecathlonConnection> {
    return this.prisma.decathlonConnection.update({
      where: { shopId },
      data: { status, lastTestedAt: new Date(), lastTestResult: result },
    });
  }
}
