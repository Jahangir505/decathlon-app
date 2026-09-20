import { Inject, Injectable } from "@nestjs/common";
import type { Repositories } from "@shopify-decathlon/database";
import { REPOSITORIES } from "../database/database.module";

@Injectable()
export class DashboardService {
  constructor(@Inject(REPOSITORIES) private readonly repositories: Repositories) {}

  async getSummary(shopId: string) {
    const [decathlonConnection, productStatusCounts, totalOrdersSynced, recentOrders, recentSyncJobs] = await Promise.all([
      this.repositories.decathlonConnections.findByShopId(shopId),
      this.repositories.productMappings.countByStatus(shopId),
      this.repositories.orderMappings.count(shopId),
      this.repositories.orderMappings.list(shopId, { take: 5 }),
      this.repositories.syncJobs.list(shopId, { take: 5 }),
    ]);

    const productCounts = Object.fromEntries(productStatusCounts.map((row) => [row.status, row._count._all]));

    return {
      decathlonConnected: decathlonConnection?.status === "CONNECTED",
      lastCatalogSyncAt: decathlonConnection?.lastTestedAt ?? null,
      products: {
        total: Object.values(productCounts).reduce((sum: number, n) => sum + (n as number), 0),
        synced: productCounts.SYNCED ?? 0,
        failed: productCounts.FAILED ?? 0,
        pending: productCounts.PENDING ?? 0,
        unmapped: productCounts.UNMAPPED ?? 0,
      },
      totalOrdersSynced,
      recentOrders,
      recentSyncJobs,
    };
  }
}
