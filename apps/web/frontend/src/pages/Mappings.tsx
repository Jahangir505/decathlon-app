import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api/client";
import { Badge, Banner, Button, Card, EmptyState, PageHeader, SkeletonLine, TextField } from "../components/ui";

interface ProductType {
  productType: string;
  productCount: number;
}
interface CategoryMappingRow {
  shopifyProductType: string;
  decathlonCategoryCode: string;
  decathlonCategoryLabel: string | null;
}
interface CategoryOption {
  code: string;
  label: string;
  path: string;
  level: number;
  deprecated: boolean;
}
interface CategoryAttribute {
  code: string;
  label: string;
  type: string;
  valuesList: string | null;
  variant: boolean;
  source: "automatic" | "mappable" | "manual";
}
interface ValueMappingRow {
  attributeCode: string;
  valuesListCode: string;
  shopifyValue: string;
  decathlonCode: string;
  decathlonLabel: string | null;
}
interface ValueOption {
  code: string;
  label: string;
}

/** Debounced remote search — every picker here searches a Decathlon list server-side rather than
 *  downloading it, since the brand list alone runs to tens of thousands of entries. */
function useRemoteSearch<T>(path: string | null, query: string, enabled = true) {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path || !enabled) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      apiGet<T[] | { items: T[] }>(`${path}${path.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (cancelled) return;
          setResults(Array.isArray(res) ? res : res.items);
        })
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, query, enabled]);

  return { results, loading };
}

function CategoryPicker({ onPick, onCancel }: { onPick: (c: CategoryOption) => void; onCancel: () => void }) {
  const [query, setQuery] = useState("");
  const { results, loading } = useRemoteSearch<CategoryOption>("/api/mappings/reference/categories", query);

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <TextField label="Search Decathlon categories" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. t-shirt, jacket, 128500" />
      <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-slate-200 bg-white">
        {loading ? (
          <div className="space-y-2 p-3">
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : results.length === 0 ? (
          <p className="p-3 text-sm text-slate-500">No categories match that search.</p>
        ) : (
          results.map((c) => (
            <button
              key={c.code}
              onClick={() => onPick(c)}
              className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-brand-50"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {c.label}
                <span className="font-mono text-xs text-slate-400">{c.code}</span>
                {c.deprecated ? <Badge tone="attention">Retired</Badge> : null}
              </span>
              <span className="text-xs text-slate-500">{c.path}</span>
            </button>
          ))
        )}
      </div>
      <div className="mt-2">
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function CategorySection() {
  const [types, setTypes] = useState<ProductType[] | null>(null);
  const [rules, setRules] = useState<CategoryMappingRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<CategoryMappingRow[]>("/api/mappings/categories").then(setRules).catch(() => setRules([]));
    apiGet<ProductType[]>("/api/mappings/shopify/product-types")
      .then(setTypes)
      .catch((e) => {
        setTypes([]);
        setError(String(e));
      });
  }, []);

  useEffect(load, [load]);

  const ruleFor = useMemo(() => new Map(rules.map((r) => [r.shopifyProductType, r])), [rules]);

  async function pick(productType: string, c: CategoryOption) {
    await apiPost("/api/mappings/categories", { productType, categoryCode: c.code, categoryLabel: c.label });
    setEditing(null);
    load();
  }

  async function clear(productType: string) {
    await apiDelete(`/api/mappings/categories?productType=${encodeURIComponent(productType)}`);
    load();
  }

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-slate-900">Product type → Decathlon category</h2>
      <p className="mt-1 text-sm text-slate-500">
        Set a category once per Shopify product type and every product of that type uses it. A product with its own
        &ldquo;Decathlon Category&rdquo; metafield overrides the rule.
      </p>

      {error ? <div className="mt-3"><Banner tone="critical">{error}</Banner></div> : null}

      {types === null ? (
        <div className="mt-4 space-y-2">
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : types.length === 0 ? (
        <div className="mt-4">
          <EmptyState heading="No product types found">
            None of your Shopify products have a product type set. Add one in Shopify, or set the Decathlon Category
            metafield per product instead.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-4 divide-y divide-slate-100">
          {types.map((t) => {
            const rule = ruleFor.get(t.productType.trim().toLowerCase());
            const isEditing = editing === t.productType;
            return (
              <div key={t.productType} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{t.productType}</p>
                    <p className="text-xs text-slate-500">{t.productCount} product{t.productCount === 1 ? "" : "s"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {rule ? (
                      <span className="text-sm text-slate-700">
                        {rule.decathlonCategoryLabel ?? "Category"}{" "}
                        <span className="font-mono text-xs text-slate-400">{rule.decathlonCategoryCode}</span>
                      </span>
                    ) : (
                      <Badge tone="attention">Not mapped</Badge>
                    )}
                    <Button onClick={() => setEditing(isEditing ? null : t.productType)}>
                      {rule ? "Change" : "Map"}
                    </Button>
                    {rule ? <Button onClick={() => clear(t.productType)}>Clear</Button> : null}
                  </div>
                </div>
                {isEditing ? <CategoryPicker onPick={(c) => pick(t.productType, c)} onCancel={() => setEditing(null)} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ValueSection() {
  const [rules, setRules] = useState<CategoryMappingRow[]>([]);
  const [categoryCode, setCategoryCode] = useState<string>("");
  const [attributes, setAttributes] = useState<CategoryAttribute[] | null>(null);
  const [mappings, setMappings] = useState<ValueMappingRow[]>([]);
  const [shopifyValue, setShopifyValue] = useState("");
  const [activeAttr, setActiveAttr] = useState<CategoryAttribute | null>(null);
  const [valueQuery, setValueQuery] = useState("");

  useEffect(() => {
    apiGet<CategoryMappingRow[]>("/api/mappings/categories").then((r) => {
      setRules(r);
      if (r[0]) setCategoryCode(r[0].decathlonCategoryCode);
    });
    apiGet<ValueMappingRow[]>("/api/mappings/values").then(setMappings).catch(() => setMappings([]));
  }, []);

  useEffect(() => {
    if (!categoryCode) return;
    setAttributes(null);
    apiGet<CategoryAttribute[]>(`/api/mappings/reference/attributes?categoryCode=${encodeURIComponent(categoryCode)}`)
      .then(setAttributes)
      .catch(() => setAttributes([]));
  }, [categoryCode]);

  const { results: valueOptions, loading: valuesLoading } = useRemoteSearch<ValueOption>(
    activeAttr?.valuesList ? `/api/mappings/reference/values?listCode=${encodeURIComponent(activeAttr.valuesList)}` : null,
    valueQuery,
  );

  async function save(option: ValueOption) {
    if (!activeAttr?.valuesList || !shopifyValue.trim()) return;
    await apiPost("/api/mappings/values", {
      attributeCode: activeAttr.code,
      valuesListCode: activeAttr.valuesList,
      shopifyValue: shopifyValue.trim(),
      decathlonCode: option.code,
      decathlonLabel: option.label,
    });
    setShopifyValue("");
    setValueQuery("");
    setActiveAttr(null);
    apiGet<ValueMappingRow[]>("/api/mappings/values").then(setMappings);
  }

  async function remove(row: ValueMappingRow) {
    await apiDelete(
      `/api/mappings/values?attributeCode=${encodeURIComponent(row.attributeCode)}&shopifyValue=${encodeURIComponent(row.shopifyValue)}`,
    );
    apiGet<ValueMappingRow[]>("/api/mappings/values").then(setMappings);
  }

  const mappable = (attributes ?? []).filter((a) => a.source === "mappable");
  const manual = (attributes ?? []).filter((a) => a.source === "manual");

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Option values → Decathlon values</h2>
      <p className="mt-1 text-sm text-slate-500">
        Decathlon controls the permitted values for some attributes. Pick a category to see exactly which ones it
        requires, then bind your Shopify option values to them.
      </p>

      {rules.length === 0 ? (
        <div className="mt-4">
          <EmptyState heading="Map a category first">
            Attribute requirements depend on the Decathlon category, so map at least one product type above.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {rules.map((r) => (
              <button
                key={r.decathlonCategoryCode}
                onClick={() => setCategoryCode(r.decathlonCategoryCode)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  categoryCode === r.decathlonCategoryCode
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {r.decathlonCategoryLabel ?? r.decathlonCategoryCode}
              </button>
            ))}
          </div>

          {attributes === null ? (
            <div className="mt-4 space-y-2">
              <SkeletonLine />
              <SkeletonLine />
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {mappable.length === 0 ? (
                <p className="text-sm text-slate-500">
                  This category requires no list-controlled attributes — nothing to map here.
                </p>
              ) : (
                mappable.map((attr) => {
                  const rows = mappings.filter((m) => m.attributeCode === attr.code);
                  return (
                    <div key={attr.code} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900">
                          {attr.label} <span className="font-mono text-xs text-slate-400">{attr.code}</span>{" "}
                          {attr.variant ? <Badge tone="info">per variant</Badge> : null}
                        </span>
                        <Button onClick={() => setActiveAttr(activeAttr?.code === attr.code ? null : attr)}>
                          Add mapping
                        </Button>
                      </div>

                      {rows.length > 0 ? (
                        <ul className="mt-2 divide-y divide-slate-100">
                          {rows.map((row) => (
                            <li key={row.shopifyValue} className="flex items-center justify-between py-1.5 text-sm">
                              <span className="text-slate-700">
                                <span className="font-medium">{row.shopifyValue}</span>
                                <span className="mx-2 text-slate-400">→</span>
                                {row.decathlonLabel ?? row.decathlonCode}
                                <span className="ml-2 font-mono text-xs text-slate-400">{row.decathlonCode}</span>
                              </span>
                              <button onClick={() => remove(row)} className="text-xs text-red-600 hover:underline">
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-xs text-slate-500">
                          No mappings yet — values are matched by name, which can miss. Add one to be explicit.
                        </p>
                      )}

                      {activeAttr?.code === attr.code ? (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <TextField
                            label="Your Shopify option value"
                            value={shopifyValue}
                            onChange={(e) => setShopifyValue(e.target.value)}
                            placeholder="e.g. Navy Blue"
                          />
                          <div className="mt-2">
                            <TextField
                              label={`Search Decathlon ${attr.label.toLowerCase()} values`}
                              value={valueQuery}
                              onChange={(e) => setValueQuery(e.target.value)}
                              placeholder="Type to search"
                            />
                          </div>
                          <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white">
                            {valuesLoading ? (
                              <div className="p-3"><SkeletonLine /></div>
                            ) : valueOptions.length === 0 ? (
                              <p className="p-3 text-sm text-slate-500">No values match.</p>
                            ) : (
                              valueOptions.map((v) => (
                                <button
                                  key={v.code}
                                  disabled={!shopifyValue.trim()}
                                  onClick={() => save(v)}
                                  className="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <span className="text-slate-800">{v.label}</span>
                                  <span className="font-mono text-xs text-slate-400">{v.code}</span>
                                </button>
                              ))
                            )}
                          </div>
                          {!shopifyValue.trim() ? (
                            <p className="mt-2 text-xs text-slate-500">Enter your Shopify value first, then pick its Decathlon match.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}

              {manual.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">Needs a value per product</p>
                  <p className="mt-1 text-xs text-amber-800">
                    Decathlon requires these for this category but they are free text, so they can&rsquo;t be mapped from a
                    list. Set them on each product&rsquo;s &ldquo;Decathlon Attributes&rdquo; metafield:{" "}
                    {manual.map((a) => `${a.label} (${a.code})`).join(", ")}.
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function Mappings() {
  return (
    <div>
      <PageHeader
        title="Mappings"
        subtitle="Tell the app how your Shopify catalogue lines up with Decathlon's categories and controlled values."
      />
      <CategorySection />
      <ValueSection />
    </div>
  );
}
