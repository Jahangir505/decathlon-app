import { createHmac, timingSafeEqual } from "node:crypto";
import { ShopifyApiError } from "@shopify-decathlon/shared";

const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_PATTERN.test(shop);
}

export interface BeginOAuthOptions {
  shop: string;
  apiKey: string;
  scopes: string[];
  redirectUri: string;
  state: string;
}

/**
 * Classic OAuth authorization-code flow — used for initial app installation (a merchant arriving at
 * the app with no session yet). Not deprecated (confirmed against shopify.dev, 2026), though token
 * exchange (token-exchange.ts) is the recommended flow for already-installed embedded apps' ongoing
 * requests. See docs/architecture.md for why both exist in this app.
 */
export function buildAuthorizationUrl(options: BeginOAuthOptions): string {
  const url = new URL(`https://${options.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", options.apiKey);
  url.searchParams.set("scope", options.scopes.join(","));
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  return url.toString();
}

/**
 * Verifies the HMAC Shopify attaches to OAuth callback query params, per Shopify's documented
 * algorithm: sort all params except hmac/signature, join as "key=value" with "&", HMAC-SHA256 with
 * the app's API secret, compare hex digest.
 */
export function verifyOAuthCallbackHmac(query: Record<string, string>, apiSecret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");

  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");

  const digestBuffer = Buffer.from(digest, "utf8");
  const hmacBuffer = Buffer.from(hmac, "utf8");
  if (digestBuffer.length !== hmacBuffer.length) return false;

  return timingSafeEqual(digestBuffer, hmacBuffer);
}

export interface OAuthCallbackResult {
  access_token: string;
  scope: string;
  [key: string]: unknown;
}

export async function exchangeCodeForAccessToken(
  shop: string,
  apiKey: string,
  apiSecret: string,
  code: string,
): Promise<OAuthCallbackResult> {
  const url = `https://${shop}/admin/oauth/access_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ShopifyApiError(`OAuth code exchange failed for ${shop}: ${response.status}`, url, response.status, text);
  }

  return (await response.json()) as OAuthCallbackResult;
}
