import type { Repositories } from "@shopify-decathlon/database";
import type { DecathlonAttribute, DecathlonClient, DecathlonHierarchy, DecathlonValueListEntry } from "@shopify-decathlon/decathlon";
import { parseAttributes, parseHierarchies, parseValueLists } from "@shopify-decathlon/decathlon";
import type { Logger } from "@shopify-decathlon/logger";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Decathlon's reference data (H11 categories, PM11 attributes, VL11 value lists), cached per shop in
 * DecathlonCatalogReference. Used by the sync engine when building a product import AND by the
 * mapping screens in the backend, which is why it lives here rather than inside SyncEngine.
 *
 * Fetch shapes differ per endpoint and the difference matters (all CONFIRMED live 2026-09-18):
 *   - PM11 ignores its `hierarchy_code` filter and always returns the full ~38-50MB catalog-wide
 *     list, so it is cached whole under one sentinel key and filtered client-side.
 *   - H11 is likewise cached whole (~860 nodes once label translations are stripped).
 *   - VL11's `code` filter IS honoured, and matters enormously: an unfiltered call returns every
 *     list in the catalog — multiple GB — so each list is fetched and cached under its own code.
 *
 * Every warm falls back to stale cache on a fetch failure: hours-old reference data is far more
 * useful than none, and none would make every attribute look unmappable.
 */
export class CatalogCache {
  /** PM11/H11 are fetched wholesale, so there is one row per shop per type — not one per category.
   *  "ALL" is a fixed sentinel, never a real Decathlon code. */
  private static readonly CATALOG_KEY = "ALL";

  constructor(
    private readonly repositories: Repositories,
    private readonly decathlon: DecathlonClient,
    private readonly logger: Logger,
  ) {}

  attributes(shopId: string): Promise<DecathlonAttribute[]> {
    return this.warm(shopId, "ATTRIBUTE", CatalogCache.CATALOG_KEY, async () =>
      parseAttributes(await this.decathlon.getProductAttributes()),
    );
  }

  hierarchies(shopId: string): Promise<DecathlonHierarchy[]> {
    return this.warm(shopId, "HIERARCHY", CatalogCache.CATALOG_KEY, async () =>
      parseHierarchies(await this.decathlon.getHierarchies()),
    );
  }

  valueList(shopId: string, listCode: string): Promise<DecathlonValueListEntry[]> {
    return this.warm(shopId, "VALUE_LIST", listCode, async () => parseValueLists(await this.decathlon.getValueLists(listCode)));
  }

  private async warm<T>(
    shopId: string,
    type: "ATTRIBUTE" | "HIERARCHY" | "VALUE_LIST",
    key: string,
    fetcher: () => Promise<T[]>,
  ): Promise<T[]> {
    const fresh = await this.repositories.catalogReferences.findFresh(shopId, type, key, ONE_HOUR_MS);
    if (fresh) return fresh.data as unknown as T[];
    try {
      const parsed = await fetcher();
      await this.repositories.catalogReferences.upsert(shopId, type, key, parsed as unknown as object);
      return parsed;
    } catch (err) {
      this.logger.warn({ event: "catalog_cache_warm_failed", shopId, type, key, err: String(err) });
      const stale = await this.repositories.catalogReferences.findFresh(shopId, type, key, Number.MAX_SAFE_INTEGER);
      return stale ? (stale.data as unknown as T[]) : [];
    }
  }
}
