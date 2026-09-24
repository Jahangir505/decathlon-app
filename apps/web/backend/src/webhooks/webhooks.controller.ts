import { Body, Controller, Headers, HttpCode, Inject, Logger, Post, Req, UnauthorizedException } from "@nestjs/common";
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
import { parseFulfillmentWebhook, parseRefundWebhook } from "@shopify-decathlon/sync";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Receives and persists Shopify webhooks (WebhookEvent rows) — always, regardless of the toggles
 * below, so nothing is lost even while automatic sync is off. `products-update` and
 * `inventory-levels-update` additionally enqueue a sync job when the shop has opted in via
 * SyncConfiguration (see apps/web/frontend's Connect Decathlon page). Fulfillments, refunds and
 * cancellations of Decathlon orders are always pushed back — those aren't optional for a seller.
 */
@Controller("api/webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

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
      const { id: productId, status } = body as { id?: number | string; status?: string };
      // REST webhook status is lowercase ("active" | "draft" | "archived"). Only active products
      // are imported; SyncEngine.syncProduct re-checks, since status can change after enqueueing.
      const productGid = productId ? toGid("Product", productId) : null;
      // In SELECTED scope only the merchant's picked products are sent, even on edit.
      const inScope =
        productGid !== null &&
        (config.productSyncScope === "ALL" || (await this.repositories.selectedProducts.isSelected(shop.id, productGid)));
      if (config.autoProductSyncEnabled && productGid && inScope && status === "active") {
        // Delayed so a burst of products/update webhooks for one edit becomes one import, and
        // marked "webhook" so a product whose Decathlon data didn't change isn't re-imported at all.
        await this.queueProducer.enqueueProductSync(
          { shopId: shop.id, shopifyProductId: productGid, trigger: "webhook" },
          { delayMs: 60_000 },
        );
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

  // Fulfillment, refund and cancellation of an order imported from Decathlon all have to be pushed
  // back: Decathlon collects the customer's payment and tells the customer about shipping, so
  // anything done only in Shopify never reaches them. Orders that didn't come from Decathlon are
  // ignored here, before a job is ever created.

  @Post("fulfillments-create")
  async fulfillmentsCreate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    await this.handleFulfillment(req, headers, body);
    return { received: true };
  }

  @Post("fulfillments-update")
  async fulfillmentsUpdate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    await this.handleFulfillment(req, headers, body);
    return { received: true };
  }

  @Post("refunds-create")
  async refundsCreate(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    const { shop } = await this.receive(req, headers, body);
    if (!shop) return { received: true };
    const payload = parseRefundWebhook(shop.id, body as Record<string, unknown>);
    if (payload && (await this.isDecathlonOrder(shop.id, payload.shopifyOrderId))) {
      await this.queueProducer.enqueueRefundSync(payload);
    }
    return { received: true };
  }

  @Post("orders-cancelled")
  async ordersCancelled(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    const { shop } = await this.receive(req, headers, body);
    const orderId = (body as { id?: number | string }).id;
    if (shop && orderId) {
      const shopifyOrderId = toGid("Order", orderId);
      if (await this.isDecathlonOrder(shop.id, shopifyOrderId)) {
        await this.queueProducer.enqueueRefundSync({ shopId: shop.id, shopifyOrderId, mode: "cancel" });
      }
    }
    return { received: true };
  }

  /**
   * Shopify's three mandatory privacy (GDPR) webhooks, registered as `compliance_topics` in
   * shopify.app.toml. Required for the App Store: the review's automated check sends each with a
   * bad signature and expects 401, and with a good one expects 200.
   *
   * The payloads themselves contain customer personal data (email, phone), so unlike every other
   * topic they are NOT stored in WebhookEvent — only a minimal, PII-free record of the request.
   */
  @Post("compliance")
  @HttpCode(200)
  async compliance(@Req() req: RawBodyRequest, @Headers() headers: Record<string, string>, @Body() body: Prisma.InputJsonValue) {
    if (!req.rawBody || !verifyShopifyWebhookHmac(req.rawBody, headers["x-shopify-hmac-sha256"], this.env.SHOPIFY_API_SECRET)) {
      throw new UnauthorizedException("Invalid webhook HMAC signature");
    }
    const { topic, shopDomain } = parseShopifyWebhookHeaders(headers);
    if (!topic || !shopDomain) throw new UnauthorizedException("Missing required webhook headers");

    const payload = body as {
      customer?: { id?: number | string };
      orders_requested?: Array<number | string>;
      orders_to_redact?: Array<number | string>;
    };

    if (topic === "shop/redact") {
      const result = await this.repositories.shops.eraseIfUninstalled(shopDomain);
      this.logger.log(`shop/redact for ${shopDomain}: ${result}`);
      return { received: true };
    }

    const shop = await this.repositories.shops.findByDomain(shopDomain);
    if (!shop) return { received: true }; // nothing stored for an unknown / already-erased shop

    const customerId = payload.customer?.id;
    if (topic === "customers/redact") {
      const orders = payload.orders_to_redact ?? [];
      const deleted = await this.repositories.webhookEvents.deleteForCustomer(shop.id, orders, customerId);
      await this.repositories.webhookEvents.record(shop.id, topic, headers["x-shopify-webhook-id"], {
        customerId: customerId === undefined ? null : String(customerId),
        orders: orders.map(String),
        deletedEvents: deleted,
      });
      this.logger.log(`customers/redact for ${shopDomain}: removed ${deleted} stored webhook payload(s)`);
      return { received: true };
    }

    if (topic === "customers/data_request") {
      // The app keeps no customer profile: personal data exists only inside stored webhook copies
      // for the listed orders. Recorded here so the merchant can be sent that data on request.
      const orders = payload.orders_requested ?? [];
      const held = await this.repositories.webhookEvents.countForCustomer(shop.id, orders, customerId);
      await this.repositories.webhookEvents.record(shop.id, topic, headers["x-shopify-webhook-id"], {
        customerId: customerId === undefined ? null : String(customerId),
        orders: orders.map(String),
        storedEventsWithCustomerData: held,
      });
      this.logger.log(`customers/data_request for ${shopDomain}: ${held} stored webhook payload(s) hold this customer's data`);
      return { received: true };
    }

    return { received: true };
  }

  private async handleFulfillment(req: RawBodyRequest, headers: Record<string, string>, body: Prisma.InputJsonValue): Promise<void> {
    const { shop } = await this.receive(req, headers, body);
    if (!shop) return;
    const payload = parseFulfillmentWebhook(shop.id, body as Record<string, unknown>);
    if (payload && (await this.isDecathlonOrder(shop.id, payload.shopifyOrderId))) {
      await this.queueProducer.enqueueFulfillmentSync(payload, headers["x-shopify-webhook-id"] ?? `${payload.shopifyFulfillmentId}-${Date.now()}`);
    }
  }

  private async isDecathlonOrder(shopId: string, shopifyOrderId: string): Promise<boolean> {
    return Boolean(await this.repositories.orderMappings.findByShopifyOrderId(shopId, shopifyOrderId));
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
