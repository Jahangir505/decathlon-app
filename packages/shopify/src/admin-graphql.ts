import { ShopifyApiError } from "@shopify-decathlon/shared";

export interface AdminGraphqlClientOptions {
  shopDomain: string;
  accessToken: string;
  apiVersion: string; // e.g. 2025-01 — must match shopify.app.toml [webhooks].api_version
}

export interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  extensions?: { cost?: Record<string, unknown> };
}

/**
 * Minimal Shopify Admin GraphQL client. Deliberately hand-rolled (not the @shopify/shopify-api SDK)
 * to keep the dependency surface small and auditable — this project only needs authenticated POST
 * requests to one endpoint, not the SDK's full REST+GraphQL+billing surface.
 */
export class ShopifyAdminGraphqlClient {
  constructor(private readonly options: AdminGraphqlClientOptions) {}

  /**
   * Retries Shopify's rate limiting (HTTP 429, or a 200 with a THROTTLED GraphQL error) with
   * backoff: the Mappings readiness check fetches up to 100 products back to back and was failing
   * part-way through with "Throttled" instead of just slowing down.
   */
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(query, variables);
      } catch (err) {
        if (attempt >= 4 || !(err instanceof ShopifyApiError) || !isThrottled(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }

  private async requestOnce<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${this.options.shopDomain}/admin/api/${this.options.apiVersion}/graphql.json`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.options.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ShopifyApiError(`Shopify Admin API request failed: ${response.status}`, url, response.status, text);
    }

    const json = (await response.json()) as GraphqlResponse<T>;

    if (json.errors?.length) {
      throw new ShopifyApiError(
        `Shopify Admin API returned GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
        url,
        response.status,
        json.errors,
      );
    }

    if (json.data === undefined) {
      throw new ShopifyApiError("Shopify Admin API response missing data", url, response.status);
    }

    return json.data;
  }
}

function isThrottled(err: ShopifyApiError): boolean {
  return err.shopifyHttpStatus === 429 || /throttled/i.test(err.message);
}

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

export interface ShopInfoResponse {
  shop: { id: string; name: string; myshopifyDomain: string; currencyCode: string };
}
