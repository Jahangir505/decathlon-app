import { Body, Controller, Headers, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import {
  verifyShopifyWebhookHmac,
  parseShopifyWebhookHeaders,
  toGid,
  INVENTORY_ITEMS_TO_VARIANTS_QUERY,
  ShopifyAdminGraphqlClient,
  type InventoryItemsToVariantsResponse,
} from "@shopify-decathlon/shopify";
import { decryptSecret, type AppEnv } from "@shopify-decathlon/shared";
import type { Prisma, Repositories, Shop } from "@shopify-decathlon/database";
import { APP_ENV } from "../config/config.module";
import { REPOSITORIES } from "../database/database.module";
import { QueueProducerService } from "../scheduler/queue-producer.service";
import { OrderImportSchedulerService } from "../scheduler/order-import-scheduler.service";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Receives and persists Shopify webhooks (WebhookEvent rows) — always, regardless of the toggles
 * below, so nothing is lost even while automatic sync is off. `products-update` and
 * `inventory-levels-update` additionally enqueue a sync job when the shop has opted in via
 * SyncConfiguration (see apps/web/frontend's Connect Decathlon page) — everything else remains
 * store-only pending the (deferred) fulfillment/refund push-back pass.
 */
@Controller("api/webhooks")
export class WebhooksController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
    private readonly queueProducer: QueueProducerService,
    private readonly orderImportScheduler: OrderImportSchedulerService,
  ) {}

  @Post("app-uninstalled")
  async appUninstalled(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    const { shop } = await this.receive(req, headers, body);
    if (shop) {
      await this.repositories.shops.markUninstalled(shop.shopifyDomain);
      await this.orderImportScheduler.removeShopSchedule(shop.id);
    }
    return { received: true };
  }

  @Post("products-update")
  async productsUpdate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    const { shop } = await this.receive(req, headers, body);
    if (shop) {
      const config = await this.repositories.syncConfigurations.getOrCreateDefault(shop.id);
      const productId = (body as { id?: number | string }).id;
      if (config.autoProductSyncEnabled && productId) {
        await this.queueProducer.enqueueProductSync({
          shopId: shop.id,
          shopifyProductId: toGid("Product", productId),
        });
      }
    }
    return { received: true };
  }

  @Post("inventory-levels-update")
  async inventoryLevelsUpdate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    const { shop } = await this.receive(req, headers, body);
    if (shop) {
      const config = await this.repositories.syncConfigurations.getOrCreateDefault(shop.id);
      const inventoryItemId = (body as { inventory_item_id?: number | string }).inventory_item_id;
      if (config.autoOfferSyncEnabled && inventoryItemId) {
        const variantGid = await this.resolveVariantFromInventoryItem(shop, inventoryItemId);
        if (variantGid) {
          await this.queueProducer.enqueueOfferSync({ shopId: shop.id, shopifyVariantIds: [variantGid] });
        }
      }
    }
    return { received: true };
  }

  @Post("fulfillments-create")
  async fulfillmentsCreate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    await this.receive(req, headers, body);
    return { received: true };
  }

  @Post("fulfillments-update")
  async fulfillmentsUpdate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    await this.receive(req, headers, body);
    return { received: true };
  }

  @Post("orders-cancelled")
  async ordersCancelled(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    await this.receive(req, headers, body);
    return { received: true };
  }

  private async receive(
    req: RawBodyRequest,
    headers: Record<string, string>,
    body: Prisma.InputJsonValue,
  ): Promise<{ shopDomain: string; shop: Shop | null }> {
    if (!req.rawBody || !verifyShopifyWebhookHmac(req.rawBody, headers["x-shopify-hmac-sha256"], this.env.SHOPIFY_API_SECRET)) {
      throw new UnauthorizedException("Invalid webhook HMAC signature");
    }

    const { topic, shopDomain } = parseShopifyWebhookHeaders(headers);
    if (!shopDomain || !topic) {
      throw new UnauthorizedException("Missing required webhook headers");
    }

    const shop = await this.repositories.shops.findByDomain(shopDomain);
    if (!shop) {
      // Webhook for a shop we don't know about (e.g. already fully uninstalled) — accept and drop.
      return { shopDomain, shop: null };
    }

    await this.repositories.webhookEvents.record(shop.id, topic, headers["x-shopify-webhook-id"], body);

    return { shopDomain, shop };
  }

  private async resolveVariantFromInventoryItem(shop: Shop, inventoryItemId: number | string): Promise<string | undefined> {
    const accessToken = decryptSecret(shop.shopifyAccessToken, this.env.ENCRYPTION_KEY);
    const shopify = new ShopifyAdminGraphqlClient({
      shopDomain: shop.shopifyDomain,
      accessToken,
      apiVersion: this.env.SHOPIFY_API_VERSION,
    });
    const res = await shopify.request<InventoryItemsToVariantsResponse>(INVENTORY_ITEMS_TO_VARIANTS_QUERY, {
      ids: [toGid("InventoryItem", inventoryItemId)],
    });
    return res.nodes[0]?.variant?.id;
  }
}
