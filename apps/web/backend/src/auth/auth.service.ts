import { Inject, Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import {
  buildAuthorizationUrl,
  exchangeCodeForAccessToken,
  verifyOAuthCallbackHmac,
  exchangeSessionTokenForAccessToken,
  verifySessionToken,
  shopDomainFromSessionToken,
  ShopifyAdminGraphqlClient,
  METAFIELD_DEFINITION_CREATE_MUTATION,
  METAFIELD_DEFINITION_PIN_MUTATION,
  METAFIELD_DEFINITIONS_QUERY,
  DECATHLON_METAFIELD_DEFINITIONS,
  type MetafieldDefinitionCreateResponse,
  type MetafieldDefinitionPinResponse,
  type MetafieldDefinitionsQueryResponse,
} from "@shopify-decathlon/shopify";
import { encryptSecret, decryptSecret, shopifyScopesArray, type AppEnv } from "@shopify-decathlon/shared";
import type { Repositories, Shop } from "@shopify-decathlon/database";
import { APP_ENV } from "../config/config.module";
import { REPOSITORIES } from "../database/database.module";

const STATE_TTL_SECONDS = 600;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  /** Signs shop+nonce into the OAuth `state` param so we don't need server-side session storage. */
  createState(shop: string): string {
    return jwt.sign({ shop }, this.env.SHOPIFY_API_SECRET, { expiresIn: STATE_TTL_SECONDS });
  }

  verifyState(state: string, expectedShop: string): boolean {
    try {
      const decoded = jwt.verify(state, this.env.SHOPIFY_API_SECRET) as { shop: string };
      return decoded.shop === expectedShop;
    } catch {
      return false;
    }
  }

  buildInstallRedirectUrl(shop: string): string {
    const state = this.createState(shop);
    return buildAuthorizationUrl({
      shop,
      apiKey: this.env.SHOPIFY_API_KEY,
      scopes: shopifyScopesArray(this.env),
      redirectUri: `${this.env.SHOPIFY_APP_URL}/api/auth/callback`,
      state,
    });
  }

  verifyCallbackHmac(query: Record<string, string>): boolean {
    return verifyOAuthCallbackHmac(query, this.env.SHOPIFY_API_SECRET);
  }

  async completeInstall(shop: string, code: string): Promise<void> {
    const result = await exchangeCodeForAccessToken(shop, this.env.SHOPIFY_API_KEY, this.env.SHOPIFY_API_SECRET, code);
    const encrypted = encryptSecret(result.access_token, this.env.ENCRYPTION_KEY);
    const shopRow = await this.repositories.shops.upsertByDomain(shop, encrypted, result.scope);
    await this.ensureDecathlonCategoryMetafieldDefinition(shopRow);
  }

  /** Called by the frontend on load with the App Bridge session token — refreshes the stored offline token. */
  async syncFromSessionToken(sessionToken: string): Promise<{ shopId: string; shopDomain: string }> {
    const decoded = verifySessionToken(sessionToken, this.env.SHOPIFY_API_KEY, this.env.SHOPIFY_API_SECRET);
    const shopDomain = shopDomainFromSessionToken(decoded);

    const result = await exchangeSessionTokenForAccessToken({
      shopDomain,
      apiKey: this.env.SHOPIFY_API_KEY,
      apiSecret: this.env.SHOPIFY_API_SECRET,
      sessionToken,
    });

    const encrypted = encryptSecret(result.access_token, this.env.ENCRYPTION_KEY);
    const shop = await this.repositories.shops.upsertByDomain(shopDomain, encrypted, result.scope);
    await this.ensureDecathlonCategoryMetafieldDefinition(shop);
    return { shopId: shop.id, shopDomain };
  }

  /**
   * Lazily creates the `custom.decathlon_category` metafield definition so it shows as a proper
   * labeled field on Shopify admin's product editor instead of merchants needing to know the raw
   * namespace/key to add it by hand. Runs once per shop (tracked via
   * Shop.decathlonCategoryMetafieldDefinitionCreated) from whichever auth path hits first — the
   * classic OAuth callback for new installs, or Token Exchange (called on every embedded page load)
   * for shops that installed before this existed, so already-installed shops self-heal without a
   * migration script.
   */
  private async ensureDecathlonCategoryMetafieldDefinition(shop: Shop): Promise<void> {
    if (shop.decathlonCategoryMetafieldDefinitionCreated) return;

    try {
      const shopify = new ShopifyAdminGraphqlClient({
        shopDomain: shop.shopifyDomain,
        accessToken: decryptSecret(shop.shopifyAccessToken, this.env.ENCRYPTION_KEY),
        apiVersion: this.env.SHOPIFY_API_VERSION,
      });
      // One flag covers every definition in DECATHLON_METAFIELD_DEFINITIONS (it predates the second
      // one) — it's only set once all of them are in place, so a partial failure retries next time.
      for (const definition of DECATHLON_METAFIELD_DEFINITIONS) {
        const res = await shopify.request<MetafieldDefinitionCreateResponse>(METAFIELD_DEFINITION_CREATE_MUTATION, { definition });
        const errors = res.metafieldDefinitionCreate.userErrors;
        // CONFIRMED via Shopify's docs: "TAKEN" (a definition already exists) and
        // "UNSTRUCTURED_ALREADY_EXISTS" (raw metafields already exist under this namespace/key without
        // a definition — e.g. set manually before this app created one) both mean the merchant already
        // has SOME form of this field — success from this method's point of view, not a failure to retry.
        const unexpected = errors.filter((e) => e.code !== "TAKEN" && e.code !== "UNSTRUCTURED_ALREADY_EXISTS");
        if (unexpected.length > 0) {
          this.logger.warn(`Failed to create ${definition.key} metafield definition for ${shop.shopifyDomain}: ${JSON.stringify(unexpected)}`);
          return; // leave the flag false so this retries on the next auth call
        }

        // CONFIRMED live 2026-09-18: an unpinned definition doesn't show on the product editor's
        // "Product metafields" card at all (it says "No metafields pinned" even though the definition
        // exists) — merchants would need to know to click "View all" to find it. Pin it so it's visible
        // by default. Definition creation doesn't take a pin flag; this is a separate mutation, and
        // re-pinning an already-pinned definition only yields a userError we can safely ignore.
        let definitionId = res.metafieldDefinitionCreate.createdDefinition?.id;
        if (!definitionId) {
          const found = await shopify.request<MetafieldDefinitionsQueryResponse>(METAFIELD_DEFINITIONS_QUERY, {
            namespace: definition.namespace,
            key: definition.key,
            ownerType: "PRODUCT",
          });
          definitionId = found.metafieldDefinitions.edges[0]?.node.id;
        }
        if (definitionId) {
          const pinRes = await shopify.request<MetafieldDefinitionPinResponse>(METAFIELD_DEFINITION_PIN_MUTATION, { definitionId });
          if (pinRes.metafieldDefinitionPin.userErrors.length > 0) {
            this.logger.warn(`Pin skipped for ${definition.key} metafield definition on ${shop.shopifyDomain}: ${JSON.stringify(pinRes.metafieldDefinitionPin.userErrors)}`);
          }
        }
      }

      await this.repositories.shops.markDecathlonCategoryMetafieldDefinitionCreated(shop.id);
    } catch (err) {
      // Best-effort — merchants can still set the metafield manually if this never succeeds, so
      // don't let a transient Shopify API failure block install/session sync.
      this.logger.warn(`Error creating decathlon_category metafield definition for ${shop.shopifyDomain}: ${String(err)}`);
    }
  }

  /** Used by the guard to authenticate embedded API requests without re-exchanging a token every call. */
  verifyEmbeddedRequestToken(sessionToken: string): { shopDomain: string } {
    const decoded = verifySessionToken(sessionToken, this.env.SHOPIFY_API_KEY, this.env.SHOPIFY_API_SECRET);
    return { shopDomain: shopDomainFromSessionToken(decoded) };
  }
}
