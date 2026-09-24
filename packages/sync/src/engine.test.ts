import { beforeEach, describe, expect, it, vi } from "vitest";

// The Decathlon catalog lookups and the P41 row builder have their own coverage; here they are
// stubbed so the tests exercise only syncProduct's own decisions.
vi.mock("./catalog-cache", () => ({
  CatalogCache: class {
    attributes = vi.fn(async () => []);
    // 128500 must exist and be a leaf, or syncProduct refuses the category before anything else.
    hierarchies = vi.fn(async () => [{ code: "128500", label: "T-shirts", level: 4, parentCode: "128000" }]);
    valueList = vi.fn(async () => []);
  },
}));
vi.mock("./matching", () => ({ matchProductMapping: vi.fn(), matchOrderLine: vi.fn() }));
vi.mock("./adapters/decathlon.adapter", async (orig) => ({
  ...(await orig<typeof import("./adapters/decathlon.adapter")>()),
  buildProductImportPayload: vi.fn(),
}));

import { SyncEngine, hashImportRow, type SyncEngineDeps } from "./engine";
import { matchProductMapping } from "./matching";
import { buildProductImportPayload } from "./adapters/decathlon.adapter";

/** Just enough of a Shopify product for syncProduct to get to its status check and past it. */
function shopifyProduct(status: "ACTIVE" | "DRAFT" | "ARCHIVED") {
  return {
    product: {
      id: "gid://shopify/Product/1",
      status,
      title: "Test Cotton T-Shirt",
      descriptionHtml: "<p>Cotton</p>",
      vendor: "Brand",
      productType: "T-Shirt",
      images: { edges: [] },
      decathlonCategory: null,
      decathlonAttributes: null,
      variants: {
        edges: [
          {
            node: {
              id: "gid://shopify/ProductVariant/1",
              sku: "TS-1",
              barcode: null,
              price: "10.00",
              selectedOptions: [],
              inventoryItem: { id: "gid://shopify/InventoryItem/1", inventoryLevels: { edges: [] } },
            },
          },
        ],
      },
    },
  };
}

function setup(status: "ACTIVE" | "DRAFT" | "ARCHIVED") {
  const logs: Array<Record<string, unknown>> = [];
  const jobs: Array<[string, string, string | undefined]> = [];
  const repositories = {
    syncJobs: { start: vi.fn(), finish: vi.fn(async (id: string, s: string, m?: string) => void jobs.push([id, s, m])) },
    syncLogs: { write: vi.fn(async (row: Record<string, unknown>) => void logs.push(row)) },
    syncConfigurations: { getOrCreateDefault: vi.fn(async () => ({ defaultCurrency: "EUR" })) },
    // No category rule: an ACTIVE product proceeds past the status check and fails here instead.
    categoryMappings: { findByProductType: vi.fn(async () => null) },
  };
  const decathlon = { importProducts: vi.fn() };
  const shopify = { request: vi.fn(async () => shopifyProduct(status)) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engine = new SyncEngine({ repositories, decathlon, shopify, logger } as unknown as SyncEngineDeps);
  const run = () => engine.syncProduct({ shopId: "s", shopifyProductId: "gid://shopify/Product/1", syncJobId: "job1" });
  return { run, logs, jobs, decathlon, repositories };
}

describe("syncProduct — only active products are imported", () => {
  it.each(["DRAFT", "ARCHIVED"] as const)("skips a %s product without calling Decathlon", async (status) => {
    const t = setup(status);
    expect(await t.run()).toBeNull();
    expect(t.decathlon.importProducts).not.toHaveBeenCalled();
    expect(t.repositories.categoryMappings.findByProductType).not.toHaveBeenCalled();
    expect(t.logs).toEqual([
      expect.objectContaining({ type: "PRODUCT_SYNC", status: "SKIPPED", errorMessage: expect.stringContaining(`is ${status.toLowerCase()} in Shopify`) }),
    ]);
    expect(t.jobs).toEqual([["job1", "SKIPPED", expect.stringContaining("only active products")]]);
  });

  it("lets an ACTIVE product through to the next check", async () => {
    const t = setup("ACTIVE");
    await t.run();
    expect(t.repositories.categoryMappings.findByProductType).toHaveBeenCalled();
    expect(t.logs[0]).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("no Decathlon category") });
  });
});

// ── Skip unchanged products on automatic syncs ─────────────────────────────────────────────────

describe("syncProduct — automatic syncs skip what Decathlon already has", () => {
  const row = (sku: string, title = "Tee") => ({ shop_sku: sku, category: "128500", productTitle: title });

  function setupSync(opts: { stored: Record<string, { hash?: string; live?: boolean }>; rows: ReturnType<typeof row>[] }) {
    const product = shopifyProduct("ACTIVE");
    product.product.productType = "T-Shirt";
    product.product.variants.edges = opts.rows.map((r, i) => ({
      node: {
        id: `gid://shopify/ProductVariant/${i + 1}`,
        sku: r.shop_sku,
        barcode: null,
        price: "10.00",
        selectedOptions: [],
        inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}`, inventoryLevels: { edges: [] } },
      },
    }));
    vi.mocked(buildProductImportPayload).mockReturnValue({ products: opts.rows } as never);
    vi.mocked(matchProductMapping).mockImplementation(async (_d, _s, v) => {
      const sku = product.product.variants.edges.find((e) => e.node.id === v.shopifyVariantId)!.node.sku;
      const st = opts.stored[sku];
      return { mapping: st ? ({ lastPayloadHash: st.hash ?? null, decathlonProductId: st.live ? "D1" : null } as never) : null };
    });
    const upserts: Array<Record<string, unknown>> = [];
    const repositories = {
      syncJobs: { start: vi.fn(), finish: vi.fn(), updateProgress: vi.fn() },
      syncLogs: { write: vi.fn() },
      syncConfigurations: { getOrCreateDefault: vi.fn(async () => ({ defaultCurrency: "EUR" })) },
      categoryMappings: { findByProductType: vi.fn(async () => ({ decathlonCategoryCode: "128500" })) },
      attributeValueMappings: { mapFor: vi.fn(async () => new Map()) },
      productMappings: { upsertForVariant: vi.fn(async (_s: string, _p: string, _v: string, data: Record<string, unknown>) => void upserts.push(data)) },
    };
    const decathlon = { importProducts: vi.fn(async () => ({ import_id: "999" })) };
    const shopify = { request: vi.fn(async () => product) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const engine = new SyncEngine({ repositories, decathlon, shopify, logger } as unknown as SyncEngineDeps);
    const run = (trigger?: "webhook" | "manual") =>
      engine.syncProduct({ shopId: "s", shopifyProductId: "gid://shopify/Product/1", syncJobId: "job1", trigger });
    return { run, decathlon, repositories, upserts };
  }

  beforeEach(() => vi.clearAllMocks());

  it("skips an unchanged product and hands back its live variants for a price/stock refresh", async () => {
    const rows = [row("A"), row("B")];
    const t = setupSync({ rows, stored: { A: { hash: hashImportRow(rows[0]!), live: true }, B: { hash: hashImportRow(rows[1]!) } } });
    const result = await t.run("webhook");
    expect(t.decathlon.importProducts).not.toHaveBeenCalled();
    expect(result).toEqual({ unchanged: true, liveVariantIds: ["gid://shopify/ProductVariant/1"], correlationId: expect.any(String) });
    expect(t.repositories.syncJobs.finish).toHaveBeenCalledWith("job1", "SKIPPED", expect.stringContaining("changed"));
  });

  it("sends only the variants that changed", async () => {
    const rows = [row("A"), row("B", "New title")];
    const t = setupSync({ rows, stored: { A: { hash: hashImportRow(rows[0]!) }, B: { hash: hashImportRow(row("B")) } } });
    const result = await t.run("webhook");
    expect(t.decathlon.importProducts).toHaveBeenCalledWith({ products: [rows[1]] });
    expect(result).toMatchObject({ importId: "999", shopifyVariantIds: ["gid://shopify/ProductVariant/2"] });
    expect(t.upserts).toEqual([expect.objectContaining({ sku: "B", lastPayloadHash: hashImportRow(rows[1]!) })]);
  });

  it("always sends on a manual sync, even when nothing changed", async () => {
    const rows = [row("A")];
    const t = setupSync({ rows, stored: { A: { hash: hashImportRow(rows[0]!) } } });
    await t.run("manual");
    expect(t.decathlon.importProducts).toHaveBeenCalledWith({ products: rows });
  });

  it("sends a never-imported product and records its fingerprint", async () => {
    const rows = [row("A")];
    const t = setupSync({ rows, stored: {} });
    await t.run("webhook");
    expect(t.decathlon.importProducts).toHaveBeenCalledTimes(1);
    expect(t.upserts[0]).toMatchObject({ lastPayloadHash: hashImportRow(rows[0]!) });
  });

  it("fingerprints ignore key order", () => {
    expect(hashImportRow({ a: 1, b: "x" })).toBe(hashImportRow({ b: "x", a: 1 }));
    expect(hashImportRow({ a: 1 })).not.toBe(hashImportRow({ a: 2 }));
  });
});
