import { decryptSecret, NotFoundError } from "@shopify-decathlon/shared";
import type { Repositories } from "@shopify-decathlon/database";
import { DecathlonClient } from "@shopify-decathlon/decathlon";
import { ShopifyAdminGraphqlClient } from "@shopify-decathlon/shopify";
import { maskSecrets, type Logger } from "@shopify-decathlon/logger";

export interface ShopContext {
  shopId: string;
  shopDomain: string;
  decathlon: DecathlonClient;
  shopify: ShopifyAdminGraphqlClient;
}

/**
 * Builds the per-shop, per-job API clients: decrypts the stored Shopify access token and Decathlon
 * API key just-in-time (never held decrypted longer than one job's lifetime), and wires each client's
 * request-logging hook to write masked ApiRequestLog rows.
 */
export async function buildShopContext(
  shopId: string,
  repositories: Repositories,
  encryptionKey: string,
  shopifyApiVersion: string,
  logger: Logger,
): Promise<ShopContext> {
  const shop = await repositories.shops.findById(shopId);
  if (!shop || !shop.isActive) {
    throw new NotFoundError(`Shop ${shopId} not found or inactive`);
  }

  const decathlonConnection = await repositories.decathlonConnections.findByShopId(shopId);
  if (!decathlonConnection) {
    throw new NotFoundError(`Shop ${shopId} has no Decathlon connection configured`);
  }

  const decathlonApiKey = decryptSecret(decathlonConnection.apiKeyEncrypted, encryptionKey);
  const shopifyAccessToken = decryptSecret(shop.shopifyAccessToken, encryptionKey);

  const decathlon = new DecathlonClient({
    baseUrl: decathlonConnection.baseUrl,
    apiKey: decathlonApiKey,
    onRequestComplete: (info) => {
      logger.debug({ event: "decathlon_api_request", shopId, ...maskSecrets(info) });
    },
  });

  const shopify = new ShopifyAdminGraphqlClient({
    shopDomain: shop.shopifyDomain,
    accessToken: shopifyAccessToken,
    apiVersion: shopifyApiVersion,
  });

  return { shopId, shopDomain: shop.shopifyDomain, decathlon, shopify };
}
