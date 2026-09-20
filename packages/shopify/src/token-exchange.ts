import { ShopifyApiError } from "@shopify-decathlon/shared";

export interface TokenExchangeOptions {
  shopDomain: string; // e.g. my-store.myshopify.com
  apiKey: string;
  apiSecret: string;
  sessionToken: string; // the id_token App Bridge hands the backend
}

export interface TokenExchangeResult {
  access_token: string;
  scope: string;
  [key: string]: unknown;
}

/**
 * Implements Shopify's Token Exchange flow — the current recommended authentication method for
 * embedded apps (confirmed against shopify.dev docs, 2026; the classic OAuth authorization-code
 * redirect is not deprecated but is no longer the recommended path for embedded apps since it forces
 * a full-page redirect out of the admin iframe).
 *
 * Flow: App Bridge gives the frontend a short-lived session token (id_token). The frontend sends it
 * to our backend, which exchanges it here for an offline access token — no merchant redirect needed,
 * as long as the app is already installed (scopes granted via Shopify's managed installation, driven
 * by shopify.app.toml).
 */
export async function exchangeSessionTokenForAccessToken(
  options: TokenExchangeOptions,
): Promise<TokenExchangeResult> {
  const url = `https://${options.shopDomain}/admin/oauth/access_token`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: options.apiKey,
      client_secret: options.apiSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: options.sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ShopifyApiError(
      `Token exchange failed for ${options.shopDomain}: ${response.status}`,
      url,
      response.status,
      text,
    );
  }

  return (await response.json()) as TokenExchangeResult;
}
