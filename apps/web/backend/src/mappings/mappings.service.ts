import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  DecathlonClient,
  ancestorCodesFor,
  findValueListEntry,
  findValueListEntryFuzzy,
  requiredAttributesForCategory,
  type DecathlonAttribute,
} from "@shopify-decathlon/decathlon";
import {
  BRAND_ATTRIBUTE_CODE,
  CatalogCache,
  GENDER_ATTRIBUTE_CODE,
  SIZE_ATTRIBUTE_CODE,
  SIZE_VALUE_LISTS,
  SyncEngine,
  categoryError,
  matchSizeInChart,
  optionRoleNames,
  parseSizeEntry,
  type ProductReadiness,
} from "@shopify-decathlon/sync";
import { createLogger } from "@shopify-decathlon/logger";
import { decryptSecret, type AppEnv } from "@shopify-decathlon/shared";
import type { Repositories } from "@shopify-decathlon/database";
import {
  ShopifyAdminGraphqlClient,
  PRODUCTS_PAGE_QUERY,
  PRODUCT_FACETS_QUERY,
  PRODUCT_SET_TYPE_MUTATION,
  effectiveProductType,
  type ProductFacetsResponse,
  type ProductSetTypeResponse,
  type ProductsPageResponse,
} from "@shopify-decathlon/shopify";
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
  /** Only a leaf category can hold products; a group such as 100000 imports but never publishes. */
  leaf: boolean;
}

export type MappingKind = "brand" | "color" | "size";

/** One Shopify value on the brand / colour / size mapping screens, with what it will be sent as. */
export interface OptionValueRow {
  /** Size rows only: sizes resolve per product type, through that type's size chart. */
  productType?: string;
  shopifyValue: string;
  productCount: number;
  /** The shop's explicit decision, if it made one. */
  mapped: { code: string; label: string | null } | null;
  /** What the importer would use without an explicit mapping. `exact` is false for a substring
   *  guess — those are the ones worth checking (e.g. vendor "Test Vendor" -> brand "test"). */
  suggestion: { code: string; label: string; exact: boolean } | null;
}

/** Where each mapping kind is stored and which Decathlon list its values come from (null = free text). */
const KIND_CONFIG: Record<MappingKind, { attributeCode: string; valuesList: string | null }> = {
  brand: { attributeCode: BRAND_ATTRIBUTE_CODE, valuesList: "brandName" },
  color: { attributeCode: "color", valuesList: "color" },
  size: { attributeCode: SIZE_ATTRIBUTE_CODE, valuesList: null },
};

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

  private async decathlonFor(shopId: string): Promise<DecathlonClient> {
    const connection = await this.repositories.decathlonConnections.findByShopId(shopId);
    if (!connection) throw new Error("Connect your Decathlon account before setting up mappings");
    const apiKey = decryptSecret(connection.apiKeyEncrypted, this.env.ENCRYPTION_KEY);
    return new DecathlonClient({ baseUrl: connection.baseUrl, apiKey });
  }

  private async catalogFor(shopId: string): Promise<CatalogCache> {
    return new CatalogCache(this.repositories, await this.decathlonFor(shopId), logger);
  }

  private async shopifyFor(shopId: string): Promise<ShopifyAdminGraphqlClient> {
    const shop = await this.repositories.shops.findById(shopId);
    if (!shop) throw new Error(`shop ${shopId} not found`);
    return new ShopifyAdminGraphqlClient({
      shopDomain: shop.shopifyDomain,
      accessToken: decryptSecret(shop.shopifyAccessToken, this.env.ENCRYPTION_KEY),
      apiVersion: this.env.SHOPIFY_API_VERSION,
    });
  }

  /** Every active product (id, type, vendor, options) — the Shopify side of the mapping screens. */
  private async activeProducts(shopId: string): Promise<ProductFacetsResponse["products"]["nodes"]> {
    const shopify = await this.shopifyFor(shopId);
    const all: ProductFacetsResponse["products"]["nodes"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res: ProductFacetsResponse = await shopify.request<ProductFacetsResponse>(PRODUCT_FACETS_QUERY, { cursor });
      all.push(...res.products.nodes);
      if (!res.products.pageInfo.hasNextPage) break;
      cursor = res.products.pageInfo.endCursor;
    }
    return all;
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
    const parents = new Set(hierarchies.map((h) => h.parentCode));
    // Specific (leaf) categories first — they are the only ones a product can be listed in.
    matches.sort((a, b) => Number(parents.has(a.code)) - Number(parents.has(b.code)));
    return matches.slice(0, limit).map((h) => ({
      code: h.code,
      label: h.label,
      path: pathFor(h.code),
      level: h.level,
      deprecated: /do not use/i.test(h.label),
      leaf: !parents.has(h.code),
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

  /**
   * Values of one or more VL11 lists (comma-separated `listCode`), lazily fetched and cached on
   * first use (some lists are tens of MB). Every word of the query must appear in the label or code,
   * so "M men top" narrows thousands of size codes to the men's-top M. Duplicate codes across
   * lists are shown once.
   */
  async searchValues(shopId: string, listCode: string, query: string, limit = 50) {
    const catalog = await this.catalogFor(shopId);
    const codes = listCode.split(",").map((c) => c.trim()).filter(Boolean);
    const seen = new Set<string>();
    const entries = (await Promise.all(codes.map((c) => catalog.valueList(shopId, c))))
      .flat()
      .filter((e) => !seen.has(e.code) && seen.add(e.code));
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length
      ? entries.filter((e) => {
          const hay = `${e.label} ${e.code}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
      : entries;
    // A value that IS one of the typed words ranks first: in "M men top" every size contains an
    // "m" (in "men"), so without this L and S outrank M. Size labels carry their chart in brackets —
    // "M (Z349: SIZE MEN TOP)" — so the value is the part before " (". Then shortest label first.
    const exact = (label: string) => (words.includes(label.split(" (")[0]!.trim().toLowerCase()) ? 0 : 1);
    matches.sort((a, b) => exact(a.label) - exact(b.label) || a.label.length - b.label.length || a.label.localeCompare(b.label));
    return { total: matches.length, items: matches.slice(0, limit).map((e) => ({ code: e.code, label: e.label })) };
  }

  /**
   * Distinct Shopify product types in the shop, with how many products use each — the left-hand side
   * of the category mapping screen. Walked from the product list rather than Shopify's deprecated
   * `shop.productTypes` connection. A product with no type is listed under its Shopify standard
   * category instead (effectiveProductType), which is what the importer matches it by.
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
        const type = effectiveProductType(node);
        if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      if (!res.products.pageInfo.hasNextPage) break;
      cursor = res.products.pageInfo.endCursor;
    }
    return [...counts.entries()]
      .map(([productType, productCount]) => ({ productType, productCount }))
      .sort((a, b) => b.productCount - a.productCount);
  }

  /** Active products with neither a product type nor a Shopify standard category — nothing a
   *  category rule can match, so the Mappings page offers to give them a type in bulk. */
  async untypedProducts(shopId: string): Promise<Array<{ shopifyProductId: string; title: string }>> {
    return (await this.activeProducts(shopId))
      .filter((p) => !effectiveProductType(p))
      .map((p) => ({ shopifyProductId: p.id, title: p.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Writes the product type to Shopify for each product. Sequential: productUpdate costs 10 points
   * and the client retries throttling, so a few hundred products finish in seconds. Each update
   * fires products/update, which syncs the product to Decathlon if automatic sync covers it.
   */
  async setProductType(shopId: string, productIds: string[], productType: string): Promise<{ updated: number; failed: Array<{ shopifyProductId: string; error: string }> }> {
    const type = (productType ?? "").trim();
    if (!type) throw new BadRequestException("Enter a product type");
    if (type.length > 255) throw new BadRequestException("Product type is too long");
    const ids = (Array.isArray(productIds) ? productIds : []).filter((id) => typeof id === "string" && id.startsWith("gid://shopify/Product/"));
    if (ids.length === 0) throw new BadRequestException("Select at least one product");

    const shopify = await this.shopifyFor(shopId);
    let updated = 0;
    const failed: Array<{ shopifyProductId: string; error: string }> = [];
    for (const id of ids) {
      try {
        const res = await shopify.request<ProductSetTypeResponse>(PRODUCT_SET_TYPE_MUTATION, { product: { id, productType: type } });
        const errors = res.productUpdate.userErrors;
        if (errors.length) failed.push({ shopifyProductId: id, error: errors.map((e) => e.message).join("; ") });
        else updated += 1;
      } catch (err) {
        failed.push({ shopifyProductId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { updated, failed };
  }

  /** Rules plus, for any that can't work, why — so a rule saved before this check existed (e.g.
   *  Footwear -> 100000) shows up as broken instead of failing silently at import time. */
  async listCategoryMappings(shopId: string) {
    const rules = await this.repositories.categoryMappings.list(shopId);
    let hierarchies: Awaited<ReturnType<CatalogCache["hierarchies"]>> = [];
    try {
      hierarchies = await (await this.catalogFor(shopId)).hierarchies(shopId);
    } catch {
      return rules.map((r) => ({ ...r, problem: null }));
    }
    return rules.map((r) => ({ ...r, problem: categoryError(hierarchies, r.decathlonCategoryCode) ?? null }));
  }

  async saveCategoryMapping(shopId: string, productType: string, categoryCode: string, categoryLabel?: string) {
    const hierarchies = await (await this.catalogFor(shopId)).hierarchies(shopId);
    const problem = categoryError(hierarchies, categoryCode);
    if (problem) throw new BadRequestException(`${problem} Choose one of its sub-categories.`);
    return this.repositories.categoryMappings.upsert(shopId, productType, categoryCode, categoryLabel);
  }

  /**
   * The Shopify side of a brand / colour / size mapping screen: every vendor (brand) or every value
   * of the colour / size option (per the shop's option names), with the explicit mapping if one
   * exists and otherwise what the importer would send.
   */
  async optionValues(shopId: string, kind: MappingKind): Promise<{ optionNames: string[]; rows: OptionValueRow[] }> {
    const cfg = KIND_CONFIG[kind];
    const config = await this.repositories.syncConfigurations.getOrCreateDefault(shopId);
    const roles = optionRoleNames(config);
    const optionNames = kind === "color" ? roles.colorOptionNames : kind === "size" ? roles.sizeOptionNames : [];

    // Sizes are counted per product type (they resolve through the type's size chart); brand and
    // colour values are the same whichever type they appear on.
    const counts = new Map<string, { productType?: string; value: string; count: number }>();
    for (const p of await this.activeProducts(shopId)) {
      const values =
        kind === "brand"
          ? [p.vendor ?? ""]
          : p.options.filter((o) => optionNames.includes(o.name.trim().toLowerCase())).flatMap((o) => o.values);
      const productType = kind === "size" ? effectiveProductType(p) || "(no product type)" : undefined;
      for (const v of new Set(values.map((x) => x.trim()).filter(Boolean))) {
        const key = `${productType ?? ""}\u0000${v}`;
        const row = counts.get(key) ?? { productType, value: v, count: 0 };
        row.count += 1;
        counts.set(key, row);
      }
    }

    const explicit = await this.repositories.attributeValueMappings.list(shopId, cfg.attributeCode);
    const byValue = new Map(explicit.map((m) => [m.shopifyValue, m]));
    const catalog = await this.catalogFor(shopId);
    const entries = cfg.valuesList ? await catalog.valueList(shopId, cfg.valuesList) : [];
    const rules = kind === "size" ? await this.repositories.categoryMappings.list(shopId) : [];
    const chartOf = new Map(rules.map((r) => [r.shopifyProductType, r.sizeChart]));
    const sizeEntries = rules.some((r) => r.sizeChart)
      ? (await Promise.all(SIZE_VALUE_LISTS.map((c) => catalog.valueList(shopId, c)))).flat()
      : [];

    const rows = [...counts.values()].map(({ productType, value: shopifyValue, count: productCount }): OptionValueRow => {
      const m = byValue.get(shopifyValue.toLowerCase());
      let suggestion: OptionValueRow["suggestion"] = null;
      if (kind === "size") {
        const chart = chartOf.get((productType ?? "").toLowerCase());
        const hit = chart ? matchSizeInChart(sizeEntries, chart, shopifyValue) : undefined;
        // exact=false with no chart hit means "sent as-is" (no chart) or "not in chart" (chart set)
        suggestion = hit
          ? { code: hit.code, label: hit.label, exact: true }
          : chart
            ? null
            : { code: shopifyValue, label: shopifyValue, exact: false };
      } else if (cfg.valuesList) {
        const exact = findValueListEntry(entries, cfg.valuesList, shopifyValue);
        const fuzzy = exact ? undefined : findValueListEntryFuzzy(entries, cfg.valuesList, shopifyValue);
        const hit = exact ?? fuzzy;
        if (hit) suggestion = { code: hit.code, label: hit.label, exact: Boolean(exact) };
      }
      return { productType, shopifyValue, productCount, mapped: m ? { code: m.decathlonCode, label: m.decathlonLabel } : null, suggestion };
    });
    rows.sort(
      (a, b) =>
        (a.productType ?? "").localeCompare(b.productType ?? "") || b.productCount - a.productCount || a.shopifyValue.localeCompare(b.shopifyValue),
    );
    return { optionNames, rows };
  }

  /** Saves one brand / colour / size decision. Size is free text; brand and colour must be real
   *  entries of their Decathlon list. */
  async saveKindMapping(shopId: string, kind: MappingKind, shopifyValue: string, decathlonCode: string, decathlonLabel?: string) {
    const cfg = KIND_CONFIG[kind];
    if (!shopifyValue.trim() || !decathlonCode.trim()) throw new BadRequestException("Both values are required");
    if (cfg.valuesList) {
      const entries = await (await this.catalogFor(shopId)).valueList(shopId, cfg.valuesList);
      if (!entries.some((e) => e.listCode === cfg.valuesList && e.code === decathlonCode)) {
        throw new BadRequestException(`"${decathlonCode}" isn't a Decathlon ${kind} code`);
      }
    }
    return this.repositories.attributeValueMappings.upsert(shopId, {
      attributeCode: cfg.attributeCode,
      valuesListCode: cfg.valuesList ?? "",
      shopifyValue: shopifyValue.trim(),
      decathlonCode: decathlonCode.trim(),
      decathlonLabel,
    });
  }

  deleteKindMapping(shopId: string, kind: MappingKind, shopifyValue: string) {
    return this.repositories.attributeValueMappings.remove(shopId, KIND_CONFIG[kind].attributeCode, shopifyValue);
  }

  /** "Confirm all": saves every exact suggestion that isn't mapped yet. Guesses are left alone —
   *  those are the ones a merchant must look at (vendor "Test Vendor" -> brand "test"). */
  async confirmAllExact(shopId: string, kind: "brand" | "color"): Promise<{ saved: number }> {
    const { rows } = await this.optionValues(shopId, kind);
    let saved = 0;
    for (const r of rows) {
      if (r.mapped || !r.suggestion?.exact) continue;
      await this.saveKindMapping(shopId, kind, r.shopifyValue, r.suggestion.code, r.suggestion.label);
      saved += 1;
    }
    return { saved };
  }

  /** Decathlon's gender list (Gender_apparel), for the per-product-type gender picker. */
  async genders(shopId: string) {
    const entries = await (await this.catalogFor(shopId)).valueList(shopId, GENDER_ATTRIBUTE_CODE);
    return entries.map((e) => ({ code: e.code, label: e.label }));
  }

  /**
   * Decathlon's size charts (Z349 SIZE MEN TOP, Z272 MEN'S SHOE SIZES, ...), derived from the size
   * lists: each code's prefix is its chart. Filtered by every word of `query`, largest first.
   */
  async sizeCharts(shopId: string, query: string, limit = 30) {
    const catalog = await this.catalogFor(shopId);
    const entries = (await Promise.all(SIZE_VALUE_LISTS.map((c) => catalog.valueList(shopId, c)))).flat();
    const charts = new Map<string, { code: string; name: string; sizes: Set<string>; examples: string[] }>();
    for (const e of entries) {
      const { chart, chartName, value } = parseSizeEntry(e);
      if (!chartName) continue;
      const c = charts.get(chart) ?? { code: chart, name: chartName, sizes: new Set<string>(), examples: [] };
      if (!c.sizes.has(e.code)) {
        c.sizes.add(e.code);
        if (c.examples.length < 6) c.examples.push(value);
      }
      charts.set(chart, c);
    }
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...charts.values()]
      .filter((c) => words.every((w) => `${c.code} ${c.name}`.toLowerCase().includes(w)))
      .sort((a, b) => b.sizes.size - a.sizes.size)
      .slice(0, limit)
      .map((c) => ({ code: c.code, name: c.name, sizeCount: c.sizes.size, examples: c.examples }));
  }

  /** Gender and size chart for one product type (its category rule must exist). */
  async saveTypeDetails(
    shopId: string,
    productType: string,
    input: { gender?: string | null; sizeChart?: string | null },
  ) {
    const rule = await this.repositories.categoryMappings.findByProductType(shopId, productType);
    if (!rule) throw new BadRequestException(`Set a Decathlon category for "${productType}" first`);
    const data: { gender?: string | null; genderLabel?: string | null; sizeChart?: string | null; sizeChartLabel?: string | null } = {};
    if (input.gender !== undefined) {
      if (input.gender === null || input.gender === "") {
        data.gender = null;
        data.genderLabel = null;
      } else {
        const g = (await this.genders(shopId)).find((x) => x.code === input.gender);
        if (!g) throw new BadRequestException(`"${input.gender}" isn't a Decathlon gender code`);
        data.gender = g.code;
        data.genderLabel = g.label;
      }
    }
    if (input.sizeChart !== undefined) {
      if (input.sizeChart === null || input.sizeChart === "") {
        data.sizeChart = null;
        data.sizeChartLabel = null;
      } else {
        const c = (await this.sizeCharts(shopId, input.sizeChart, 500)).find((x) => x.code === input.sizeChart);
        if (!c) throw new BadRequestException(`"${input.sizeChart}" isn't a Decathlon size chart`);
        data.sizeChart = c.code;
        data.sizeChartLabel = c.name;
      }
    }
    return this.repositories.categoryMappings.updateDetails(shopId, productType, data);
  }

  /**
   * Import readiness of every active product: the real import preparation, run without sending
   * anything (SyncEngine.checkProduct). What the merchant sees here is exactly what an import would
   * accept or refuse, and why.
   */
  async readiness(shopId: string): Promise<{ ready: number; blocked: number; products: ProductReadiness[] }> {
    const engine = new SyncEngine({
      repositories: this.repositories,
      decathlon: await this.decathlonFor(shopId),
      shopify: await this.shopifyFor(shopId),
      logger,
    });
    const products: ProductReadiness[] = [];
    for (const p of (await this.activeProducts(shopId)).slice(0, 100)) {
      try {
        products.push(await engine.checkProduct(shopId, p.id));
      } catch (err) {
        products.push({ shopifyProductId: p.id, title: p.id, status: "blocked", variants: 0, problems: [`Couldn't check: ${String(err)}`] });
      }
    }
    return {
      ready: products.filter((p) => p.status === "ready").length,
      blocked: products.filter((p) => p.status === "blocked").length,
      products,
    };
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
