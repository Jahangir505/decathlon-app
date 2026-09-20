import { Inject, Injectable } from "@nestjs/common";
import { DecathlonClient } from "@shopify-decathlon/decathlon";
import { decryptSecret, encryptSecret, type AppEnv } from "@shopify-decathlon/shared";
import type { DecathlonEnvironment, Repositories } from "@shopify-decathlon/database";
import { APP_ENV } from "../config/config.module";
import { REPOSITORIES } from "../database/database.module";
import { OrderImportSchedulerService } from "../scheduler/order-import-scheduler.service";

export interface SaveConnectionInput {
  apiKey: string;
  environment: DecathlonEnvironment;
  baseUrl: string;
}

@Injectable()
export class DecathlonConnectionService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
    private readonly orderImportScheduler: OrderImportSchedulerService,
  ) {}

  async getStatus(shopId: string) {
    const connection = await this.repositories.decathlonConnections.findByShopId(shopId);
    if (!connection) {
      return { configured: false as const };
    }
    return {
      configured: true as const,
      environment: connection.environment,
      baseUrl: connection.baseUrl,
      status: connection.status,
      lastTestedAt: connection.lastTestedAt,
    };
  }

  async save(shopId: string, input: SaveConnectionInput) {
    const apiKeyEncrypted = encryptSecret(input.apiKey, this.env.ENCRYPTION_KEY);
    await this.repositories.decathlonConnections.upsert(shopId, {
      apiKeyEncrypted,
      environment: input.environment,
      baseUrl: input.baseUrl,
    });
    return this.testConnection(shopId);
  }

  /**
   * Per requirement §28: exercises a real (cheap) read against the Decathlon API and reports back
   * whether auth succeeded — never echoes the API key back to the frontend.
   */
  async testConnection(shopId: string) {
    const connection = await this.repositories.decathlonConnections.findByShopId(shopId);
    if (!connection) {
      return { ok: false as const, error: "No Decathlon connection configured for this shop" };
    }

    const apiKey = decryptSecret(connection.apiKeyEncrypted, this.env.ENCRYPTION_KEY);
    const client = new DecathlonClient({ baseUrl: connection.baseUrl, apiKey });
    const result = await client.testConnection();

    await this.repositories.decathlonConnections.recordTestResult(
      shopId,
      result.ok ? "CONNECTED" : "FAILED",
      result.ok ? { ok: true } : { ok: false, error: result.error },
    );

    // A connection going CONNECTED/FAILED changes whether the order-import schedule should be
    // running at all — reconcile immediately rather than waiting for the 5-minute sweep.
    await this.orderImportScheduler.reconcileShop(shopId);

    return result;
  }
}
