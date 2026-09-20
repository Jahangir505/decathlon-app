import { Inject, Injectable } from "@nestjs/common";
import { DecathlonClient, ancestorCodesFor, requiredAttributesForCategory, type DecathlonAttribute } from "@shopify-decathlon/decathlon";
import { CatalogCache } from "@shopify-decathlon/sync";
import { createLogger } from "@shopify-decathlon/logger";
import { decryptSecret, type AppEnv } from "@shopify-decathlon/shared";
import type { Repositories } from "@shopify-decathlon/database";
import { ShopifyAdminGraphqlClient, PRODUCTS_PAGE_QUERY, type ProductsPageResponse } from "@shopify-decathlon/shopify";
import { APP_ENV } from "../config/config.module";
import { REPOSITORIES } from "../database/database.module";

const logger = createLogger("mappings");

export interface CategoryOption {
  code: string;
  label: string;
  /** Root-to-leaf path, e.g. "Apparel, Footwear, Accessories > Clothing > Tops > T-shirts". */
  path: string;
  level: number;
  /** Decathlon marks retired categories by putting "DO NOT USE" in the label itself. They are still
   *  returned (some sellers have live offers on them) but flagged so the UI can warn. */
  deprecated: boolean;
}

/** An attribute a chosen category actually requires, plus whether this app can fill it by itself. */
export interface CategoryAttribute {
  code: string;
  label: string;
  type: string;
  valuesList: string | null;
  /** True when Decathlon expects this to differ per variant (e.g. colour, size). */
  variant: boolean;
  /** How this app sources the value — drives what the Mappings UI asks the merchant for. */
  source: "automatic" | "mappable" | "manual";
}

/** Attributes the import builder fills from data it already has — nothing to map. */
const AUTOMATIC_ATTRIBUTE_CODES = new Set([
  "category",
  "ProductIdentifier",
  "main_image",
  "ean_codes",
  "brandName",
  "GPSR_MANUFACTURER_EMAIL_ADDRESS",
]);

@Injectable()
export class MappingsService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  private async catalogFor(shopId: string): Promise<CatalogCache> {
    const connection = await this.repositories.decathlonConnections.findByShopId(shopId);
    if (!connection) throw new Error("Connect your Decathlon account before setting up mappings");
    const apiKey = decryptSecret(connection.apiKeyEncrypted, this.env.ENCRYPTION_KEY);
    const client = new DecathlonClient({ baseUrl: connection.baseUrl, apiKey });
    return new CatalogCache(this.repositories, client, logger);
  }

  /**
   * Searchable H11 tree. The full tree is ~860 nodes, small enough to filter in memory — but the
   * response is capped because a bare search would otherwise return all of them at once.
   */
  async searchCategories(shopId: string, query: string, limit = 50): Promise<CategoryOption[]> {
    const catalog = await this.catalogFor(shopId);
    const hierarchies = await catalog.hierarchies(shopId);
    const byCode = new Map(hierarchies.map((h) => [h.code, h]));
    const pathFor = (code: string): string => {
      const parts = [...ancestorCodesFor(hierarchies, code).map((c) => byCode.get(c)?.label ?? c), byCode.get(code)?.label ?? code];
      return parts.join(" > ");
    };

    const q = query.trim().toLowerCase();
    const matches = hierarchies.filter((h) => !q || h.label.toLowerCase().includes(q) || h.code.toLowerCase() === q);
    // Non-deprecated first, then shallower categories, so the useful ones surface above the
    // "DO NOT USE" trees that would otherwise dominate an apparel search.
    matches.sort((a, b) => {
      const da = /do not use/i.test(a.label) ? 1 : 0;
      const db = /do not use/i.test(b.label) ? 1 : 0;
      return da - db || a.level - b.level || a.label.localeCompare(b.label);
    });
    return matches.slice(0, limit).map((h) => ({
      code: h.code,
      label: h.label,
      path: pathFor(h.code),
      level: h.level,
      deprecated: /do not use/i.test(h.label),
    }));
  }

  /**
   * What a given category actually demands. This is what makes the Mappings screen honest: rather
   * than offering a fixed "size and colour" form, it reports the attributes Decathlon really
   * attaches to this category and its ancestors — which for much of the apparel tree is colour only.
   */
  async categoryAttributes(shopId: string, categoryCode: string): Promise<CategoryAttribute[]> {
    const catalog = await this.catalogFor(shopId);
    const [attributes, hierarchies] = await Promise.all([catalog.attributes(shopId), catalog.hierarchies(shopId)]);
    const ancestors = ancestorCodesFor(hierarchies, categoryCode);
    return requiredAttributesForCategory(attributes, categoryCode, ancestors).map((a) => ({
      code: a.code,
      label: a.label,
      type: a.type,
      valuesList: a.valuesList ?? null,
      variant: a.variant,
      source: this.sourceFor(a),
    }));
  }

  private sourceFor(attr: DecathlonAttribute): CategoryAttribute["source"] {
    if (AUTOMATIC_ATTRIBUTE_CODES.has(attr.code)) return "automatic";
    // A LIST attribute is mappable: its values come from a Decathlon-controlled list, so a merchant
    // can bind their own Shopify option values to it. Anything else needs a literal value per
    // product, which is what the decathlon_attributes metafield is for.
    return attr.type === "LIST" && attr.valuesList ? "mappable" : "manual";
  }

  /** Values of one VL11 list, lazily fetched and cached on first use (some lists are tens of MB). */
  async searchValues(shopId: string, listCode: string, query: string, limit = 50) {
    const catalog = await this.catalogFor(shopId);
    const entries = await catalog.valueList(shopId, listCode);
    const q = query.trim().toLowerCase();
    const matches = q ? entries.filter((e) => e.label.toLowerCase().includes(q) || e.code.toLowerCase() === q) : entries;
    return { total: matches.length, items: matches.slice(0, limit).map((e) => ({ code: e.code, label: e.label })) };
  }

  /**
   * Distinct Shopify product types in the shop, with how many products use each — the left-hand side
   * of the category mapping screen. Walked from the product list rather than Shopify's deprecated
   * `shop.productTypes` connection.
   */
  async shopifyProductTypes(shopId: string): Promise<Array<{ productType: string; productCount: number }>> {
    const shop = await this.repositories.shops.findById(shopId);
    if (!shop) throw new Error(`shopifyProductTypes: shop ${shopId} not found`);
    const shopify = new ShopifyAdminGraphqlClient({
      shopDomain: shop.shopifyDomain,
      accessToken: decryptSecret(shop.shopifyAccessToken, this.env.ENCRYPTION_KEY),
      apiVersion: this.env.SHOPIFY_API_VERSION,
    });
    const counts = new Map<string, number>();
    let cursor: string | null = null;
    // Bounded at 20 pages (1000 products) so a huge catalogue can't hang the mapping screen.
    for (let page = 0; page < 20; page++) {
      const res: ProductsPageResponse = await shopify.request<ProductsPageResponse>(PRODUCTS_PAGE_QUERY, { cursor });
      for (const { node } of res.products.edges) {
        const type = (node.productType ?? "").trim();
        if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      if (!res.products.pageInfo.hasNextPage) break;
      cursor = res.products.pageInfo.endCursor;
    }
    return [...counts.entries()]
      .map(([productType, productCount]) => ({ productType, productCount }))
      .sort((a, b) => b.productCount - a.productCount);
  }

  listCategoryMappings(shopId: string) {
    return this.repositories.categoryMappings.list(shopId);
  }

  saveCategoryMapping(shopId: string, productType: string, categoryCode: string, categoryLabel?: string) {
    return this.repositories.categoryMappings.upsert(shopId, productType, categoryCode, categoryLabel);
  }

  deleteCategoryMapping(shopId: string, productType: string) {
    return this.repositories.categoryMappings.remove(shopId, productType);
  }

  listValueMappings(shopId: string, attributeCode?: string) {
    return this.repositories.attributeValueMappings.list(shopId, attributeCode);
  }

  saveValueMapping(
    shopId: string,
    input: { attributeCode: string; valuesListCode: string; shopifyValue: string; decathlonCode: string; decathlonLabel?: string },
  ) {
    return this.repositories.attributeValueMappings.upsert(shopId, input);
  }

  deleteValueMapping(shopId: string, attributeCode: string, shopifyValue: string) {
    return this.repositories.attributeValueMappings.remove(shopId, attributeCode, shopifyValue);
  }
}
