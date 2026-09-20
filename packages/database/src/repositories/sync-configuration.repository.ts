import type { Prisma, PrismaClient, SyncConfiguration } from "@prisma/client";

export class SyncConfigurationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  getOrCreateDefault(shopId: string): Promise<SyncConfiguration> {
    return this.prisma.syncConfiguration.upsert({
      where: { shopId },
      create: { shopId },
      update: {},
    });
  }

  update(shopId: string, data: Prisma.SyncConfigurationUpdateInput): Promise<SyncConfiguration> {
    return this.prisma.syncConfiguration.update({ where: { shopId }, data });
  }
}
