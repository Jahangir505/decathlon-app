import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-Shopify-Hmac-Sha256 header against the raw request body. `rawBody` MUST be the
 * exact bytes Shopify sent (before any JSON parsing/re-serialization) or the signature will never
 * match — the NestJS route handling this must use a raw-body parser for webhook endpoints.
 */
export function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined, apiSecret: string): boolean {
  if (!hmacHeader) return false;

  const digest = createHmac("sha256", apiSecret).update(rawBody).digest("base64");

  const digestBuffer = Buffer.from(digest, "utf8");
  const headerBuffer = Buffer.from(hmacHeader, "utf8");
  if (digestBuffer.length !== headerBuffer.length) return false;

  return timingSafeEqual(digestBuffer, headerBuffer);
}

export interface ShopifyWebhookHeaders {
  topic?: string;
  shopDomain?: string;
  webhookId?: string;
  apiVersion?: string;
}

/** Shopify's standard webhook header names, lower-cased as Node's http layer delivers them. */
export function parseShopifyWebhookHeaders(headers: Record<string, string | string[] | undefined>): ShopifyWebhookHeaders {
  const get = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    topic: get("x-shopify-topic"),
    shopDomain: get("x-shopify-shop-domain"),
    webhookId: get("x-shopify-webhook-id"),
    apiVersion: get("x-shopify-api-version"),
  };
}
