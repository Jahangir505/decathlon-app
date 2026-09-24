import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api/client";
import { Badge, Banner, Button, Card, EmptyState, PageHeader, Select, SkeletonLine, TextField } from "../components/ui";

interface ProductType {
  productType: string;
  productCount: number;
}
interface CategoryMappingRow {
  shopifyProductType: string;
  decathlonCategoryCode: string;
  decathlonCategoryLabel: string | null;
  /** Set when the rule can't work, e.g. it points at a category group. */
  problem?: string | null;
  gender?: string | null;
  genderLabel?: string | null;
  sizeChart?: string | null;
  sizeChartLabel?: string | null;
}
interface SizeChart {
  code: string;
  name: string;
  sizeCount: number;
  examples: string[];
}
export interface Readiness {
  ready: number;
  blocked: number;
  products: Array<{ shopifyProductId: string; title: string; status: "ready" | "blocked" | "skipped"; variants: number; problems: string[] }>;
}
interface CategoryOption {
  code: string;
  label: string;
  path: string;
  level: number;
  deprecated: boolean;
  leaf: boolean;
}
type MappingKind = "brand" | "color" | "size";
interface OptionValueRow {
  productType?: string;
  shopifyValue: string;
  productCount: number;
  mapped: { code: string; label: string | null } | null;
  suggestion: { code: string; label: string; exact: boolean } | null;
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
              onClick={() => c.leaf && onPick(c)}
              disabled={!c.leaf}
              title={c.leaf ? undefined : "This is a group of categories — pick one of its sub-categories"}
              className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                {c.label}
                <span className="font-mono text-xs text-slate-400">{c.code}</span>
                {c.deprecated ? <Badge tone="attention">Retired</Badge> : null}
                {!c.leaf ? <Badge tone="info">Group</Badge> : null}
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

/** Top of the page: the real import checks, run on every active product without sending anything. */
function ReadinessSection({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    apiGet<Readiness>("/api/mappings/readiness")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(run, [run, refreshKey]);

  const blocked = data?.products.filter((p) => p.status === "blocked") ?? [];
  const total = (data?.ready ?? 0) + (data?.blocked ?? 0);

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Ready to import?</h2>
          <p className="mt-1 text-sm text-slate-500">
            Runs the same checks as a real import on every active product — nothing is sent to Decathlon.
          </p>
        </div>
        <Button loading={loading} onClick={run}>
          Check again
        </Button>
      </div>
      {error ? <div className="mt-3"><Banner tone="critical">{error}</Banner></div> : null}
      {data === null ? (
        <div className="mt-4 space-y-2">
          <SkeletonLine />
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-sm">
            <Badge tone={data.blocked === 0 ? "success" : "attention"}>
              {data.ready} of {total} ready
            </Badge>
            {data.blocked === 0 ? <span className="ml-2 text-slate-600">Every active product passes the import checks.</span> : null}
          </p>
          {blocked.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {blocked.map((p) => (
                <li key={p.shopifyProductId} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">{p.title}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-800">
                    {p.problems.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function SizeChartPicker({ onPick, onCancel }: { onPick: (c: SizeChart | null) => void; onCancel: () => void }) {
  const [query, setQuery] = useState("");
  const { results, loading } = useRemoteSearch<SizeChart>("/api/mappings/reference/size-charts", query);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <TextField label="Search Decathlon size charts" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. men top, women shoe, kid" />
      <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white">
        {loading ? (
          <div className="p-3"><SkeletonLine /></div>
        ) : results.length === 0 ? (
          <p className="p-3 text-sm text-slate-500">No size charts match.</p>
        ) : (
          results.map((c) => (
            <button
              key={c.code}
              onClick={() => onPick(c)}
              className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-brand-50"
            >
              <span className="text-sm font-medium text-slate-900">
                {c.name} <span className="font-mono text-xs text-slate-400">{c.code}</span>
              </span>
              <span className="text-xs text-slate-500">
                {c.sizeCount} sizes, e.g. {c.examples.join(", ")}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => onPick(null)}>No size chart</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * Products with neither a product type nor a Shopify standard category can't be matched by any
 * category rule. Filter them by title, select, and give them a type in one go; the type is written
 * to Shopify, and then appears under "Product types" below for mapping.
 */
function UntypedSection({ onChange, refreshKey }: { onChange: () => void; refreshKey: number }) {
  const [products, setProducts] = useState<Array<{ shopifyProductId: string; title: string }> | null>(null);
  const [existingTypes, setExistingTypes] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [productType, setProductType] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "critical" | "attention"; text: string } | null>(null);

  const load = useCallback(() => {
    apiGet<Array<{ shopifyProductId: string; title: string }>>("/api/mappings/shopify/untyped-products")
      .then(setProducts)
      .catch(() => setProducts([]));
    apiGet<ProductType[]>("/api/mappings/shopify/product-types")
      .then((t) => setExistingTypes(t.map((x) => x.productType)))
      .catch(() => setExistingTypes([]));
  }, []);

  useEffect(load, [load, refreshKey]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (products ?? []).filter((p) => !q || p.title.toLowerCase().includes(q));
  }, [products, filter]);

  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.shopifyProductId));

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const p of visible) {
        if (allVisibleSelected) next.delete(p.shopifyProductId);
        else next.add(p.shopifyProductId);
      }
      return next;
    });
  }

  async function apply() {
    setSaving(true);
    setResult(null);
    try {
      const res = await apiPost<{ updated: number; failed: Array<{ shopifyProductId: string; error: string }> }>(
        "/api/mappings/shopify/product-type",
        { productIds: [...selected], productType },
      );
      setResult(
        res.failed.length
          ? { tone: "attention", text: `Set "${productType.trim()}" on ${res.updated} products; ${res.failed.length} failed: ${res.failed[0].error}` }
          : { tone: "success", text: `Set "${productType.trim()}" on ${res.updated} products. Now pick its Decathlon category under Product types below.` },
      );
      setSelected(new Set());
      setFilter("");
      load();
      onChange();
    } catch (e) {
      setResult({ tone: "critical", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (products === null || (products.length === 0 && !result)) return null;

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-slate-900">Products without a type ({products.length})</h2>
      <p className="mt-1 text-sm text-slate-500">
        These products have no product type or Shopify product category, so no category rule can match them. Search by
        name (for example &ldquo;T-Shirt&rdquo;), select them, and give them a type. The type is saved to your products in
        Shopify.
      </p>

      {result ? <div className="mt-3"><Banner tone={result.tone}>{result.text}</Banner></div> : null}

      {products.length > 0 ? (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <TextField label="Search product names" placeholder="e.g. T-Shirt" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div>
              <TextField
                label={`Product type for ${selected.size} selected`}
                placeholder="e.g. T-Shirts"
                list="existing-product-types"
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
              />
              <datalist id="existing-product-types">
                {existingTypes.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <Button variant="primary" loading={saving} disabled={selected.size === 0 || !productType.trim()} onClick={apply}>
              Set type
            </Button>
          </div>

          <div className="mt-4 max-h-80 overflow-y-auto rounded-lg ring-1 ring-inset ring-slate-200">
            <label className="sticky top-0 flex cursor-pointer items-center gap-2.5 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
              />
              {filter.trim() ? `Select all ${visible.length} matching` : `Select all ${visible.length}`}
            </label>
            {visible.map((p) => (
              <label key={p.shopifyProductId} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                  checked={selected.has(p.shopifyProductId)}
                  onChange={() => toggle(p.shopifyProductId)}
                />
                {p.title}
              </label>
            ))}
            {visible.length === 0 ? <p className="px-3 py-4 text-sm text-slate-500">No product names match &ldquo;{filter}&rdquo;.</p> : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function CategorySection({ onChange, refreshKey }: { onChange: () => void; refreshKey: number }) {
  const [types, setTypes] = useState<ProductType[] | null>(null);
  const [rules, setRules] = useState<CategoryMappingRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingChart, setEditingChart] = useState<string | null>(null);
  const [genders, setGenders] = useState<ValueOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<ValueOption[]>("/api/mappings/reference/genders").then(setGenders).catch(() => setGenders([]));
  }, []);

  async function saveDetails(productType: string, details: { gender?: string | null; sizeChart?: string | null }) {
    try {
      await apiPost("/api/mappings/categories/details", { productType, ...details });
      setError(null);
      setEditingChart(null);
      load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const load = useCallback(() => {
    apiGet<CategoryMappingRow[]>("/api/mappings/categories").then(setRules).catch(() => setRules([]));
    apiGet<ProductType[]>("/api/mappings/shopify/product-types")
      .then(setTypes)
      .catch((e) => {
        setTypes([]);
        setError(String(e));
      });
  }, []);

  useEffect(load, [load, refreshKey]);

  const ruleFor = useMemo(() => new Map(rules.map((r) => [r.shopifyProductType, r])), [rules]);

  async function pick(productType: string, c: CategoryOption) {
    try {
      await apiPost("/api/mappings/categories", { productType, categoryCode: c.code, categoryLabel: c.label });
      setError(null);
      setEditing(null);
      load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear(productType: string) {
    await apiDelete(`/api/mappings/categories?productType=${encodeURIComponent(productType)}`);
    load();
    onChange();
  }

  return (
    <Card className="mb-6">
      <h2 className="text-base font-semibold text-slate-900">Product types</h2>
      <p className="mt-1 text-sm text-slate-500">
        Set these once per Shopify product type and every product of that type uses them: its Decathlon category,
        gender, and size chart (sizes are then matched to Decathlon&rsquo;s codes automatically). A product&rsquo;s own
        &ldquo;Decathlon Category&rdquo; or &ldquo;Decathlon Attributes&rdquo; metafield overrides the rule.
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
            None of your products has a product type or Shopify product category yet. Give them one under
            &ldquo;Products without a type&rdquo; above.
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
                {rule && !rule.problem ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      label="Gender"
                      value={rule.gender ?? ""}
                      options={[{ label: "— choose —", value: "" }, ...genders.map((g) => ({ label: g.label, value: g.code }))]}
                      onChange={(e) => saveDetails(t.productType, { gender: e.target.value || null })}
                    />
                    <div>
                      <span className="mb-1.5 block text-sm font-medium text-slate-700">Size chart</span>
                      <div className="flex items-center gap-2">
                        {rule.sizeChart ? (
                          <span className="text-sm text-slate-700">
                            {rule.sizeChartLabel} <span className="font-mono text-xs text-slate-400">{rule.sizeChart}</span>
                          </span>
                        ) : (
                          <Badge tone="attention">None — sizes sent as typed</Badge>
                        )}
                        <Button onClick={() => setEditingChart(editingChart === t.productType ? null : t.productType)}>
                          {rule.sizeChart ? "Change" : "Choose"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
                {editingChart === t.productType ? (
                  <SizeChartPicker
                    onPick={(c) => saveDetails(t.productType, { sizeChart: c?.code ?? null })}
                    onCancel={() => setEditingChart(null)}
                  />
                ) : null}
                {rule?.problem ? (
                  <p className="mt-2 text-xs text-red-600">
                    {rule.problem} Products of this type won&rsquo;t import until you pick a specific category.
                  </p>
                ) : null}
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

  // Colour has its own section above; this one covers any other list a category requires.
  const mappable = (attributes ?? []).filter((a) => a.source === "mappable" && a.code !== "color");
  const manual = (attributes ?? []).filter((a) => a.source === "manual");

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Other category attributes</h2>
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

const KIND_TEXT: Record<
  MappingKind,
  {
    title: string;
    intro: string;
    listCode: string | null;
    searchLabel: string;
    searchPlaceholder: string;
    /** Also offer a typed value — for sizes, where Decathlon may expect something not in its lists. */
    allowFreeText?: boolean;
    emptyHeading: string;
    emptyBody: string;
    setting?: "colorOptionName" | "sizeOptionName";
  }
> = {
  brand: {
    title: "Vendor → Decathlon brand",
    intro:
      "Every product needs a real Decathlon brand. Without a mapping the app guesses from the Shopify vendor name, and a guess can be wrong — check anything marked “Guess”.",
    listCode: "brandName",
    searchLabel: "Search Decathlon brands",
    searchPlaceholder: "Type to search",
    emptyHeading: "No vendors found",
    emptyBody: "None of your active products has a vendor set in Shopify.",
  },
  color: {
    title: "Colour option → Decathlon colour",
    intro:
      "Each variant's colour is read from this Shopify option and sent as Decathlon's Main color. Values are matched by name when you haven't mapped them.",
    listCode: "color",
    searchLabel: "Search Decathlon colours",
    searchPlaceholder: "Type to search",
    emptyHeading: "No colour option found",
    emptyBody:
      "None of your active products has an option with this name. Rename the option name here, or set the colour per product in the “Decathlon Attributes” metafield.",
    setting: "colorOptionName",
  },
  size: {
    title: "Size option → Decathlon size",
    intro:
      "Each variant's size is read from this Shopify option and sent as Decathlon's SIZE. Choose a size chart per product type above and sizes are matched automatically (M → SIZE MEN TOP M, US 9 → UK 8 - EU 42). Map a size here only to override the automatic match.",
    listCode: "size_cpn_7,size_cpn_4",
    searchLabel: "Search Decathlon sizes",
    searchPlaceholder: "e.g. M men top, EU 42, UK 8 shoe",
    allowFreeText: true,
    emptyHeading: "No size option found",
    emptyBody: "None of your active products has an option with this name. Rename the option name here if yours differs.",
    setting: "sizeOptionName",
  },
};

function KindSection({ kind, onChange, refreshKey }: { kind: MappingKind; onChange: () => void; refreshKey: number }) {
  const text = KIND_TEXT[kind];
  const [data, setData] = useState<{ optionNames: string[]; rows: OptionValueRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [freeText, setFreeText] = useState("");
  const [optionName, setOptionName] = useState("");

  const load = useCallback(() => {
    apiGet<{ optionNames: string[]; rows: OptionValueRow[] }>(`/api/mappings/kind/${kind}`)
      .then((d) => {
        setData(d);
        setOptionName(d.optionNames.join(", "));
      })
      .catch((e) => {
        setData({ optionNames: [], rows: [] });
        setError(String(e));
      });
  }, [kind]);
  useEffect(load, [load, refreshKey]);
  const [confirming, setConfirming] = useState(false);

  async function confirmAll() {
    setConfirming(true);
    try {
      await apiPost(`/api/mappings/kind/${kind}/confirm-all`);
      load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  }
  const unconfirmedExact = (data?.rows ?? []).filter((r) => !r.mapped && r.suggestion?.exact).length;

  const { results, loading } = useRemoteSearch<ValueOption>(
    text.listCode ? `/api/mappings/reference/values?listCode=${encodeURIComponent(text.listCode)}` : null,
    query,
    editing !== null,
  );

  async function save(shopifyValue: string, decathlonCode: string, decathlonLabel?: string) {
    try {
      await apiPost(`/api/mappings/kind/${kind}`, { shopifyValue, decathlonCode, decathlonLabel });
      setError(null);
      setEditing(null);
      setQuery("");
      setFreeText("");
      load();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear(shopifyValue: string) {
    await apiDelete(`/api/mappings/kind/${kind}?shopifyValue=${encodeURIComponent(shopifyValue)}`);
    load();
    onChange();
  }

  async function saveOptionName() {
    if (!text.setting) return;
    await apiPost("/api/sync-configuration", { [text.setting]: optionName.trim() || null });
    load();
  }

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{text.title}</h2>
          <p className="mt-1 text-sm text-slate-500">{text.intro}</p>
        </div>
        {kind !== "size" && unconfirmedExact > 0 ? (
          <Button variant="primary" loading={confirming} onClick={confirmAll}>
            Confirm {unconfirmedExact} exact match{unconfirmedExact === 1 ? "" : "es"}
          </Button>
        ) : null}
      </div>

      {text.setting ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-64">
            <TextField
              label="Shopify option name(s)"
              value={optionName}
              onChange={(e) => setOptionName(e.target.value)}
              placeholder={kind === "color" ? "Color, Colour" : "Size"}
            />
          </div>
          <Button onClick={saveOptionName}>Save</Button>
        </div>
      ) : null}

      {error ? <div className="mt-3"><Banner tone="critical">{error}</Banner></div> : null}

      {data === null ? (
        <div className="mt-4 space-y-2">
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState heading={text.emptyHeading}>{text.emptyBody}</EmptyState>
        </div>
      ) : (
        <div className="mt-4 divide-y divide-slate-100">
          {data.rows.map((row, i) => {
            const rowKey = `${row.productType ?? ""}::${row.shopifyValue}`;
            const isEditing = editing === rowKey;
            const newGroup = kind === "size" && row.productType !== data.rows[i - 1]?.productType;
            return (
              <div key={rowKey} className="py-3">
                {newGroup ? (
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Product type: {row.productType}</p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{row.shopifyValue}</p>
                    <p className="text-xs text-slate-500">
                      {row.productCount} product{row.productCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {row.mapped ? (
                      <>
                        <Badge tone="success">Mapped</Badge>
                        <span className="text-sm text-slate-700">
                          {row.mapped.label ?? row.mapped.code}{" "}
                          <span className="font-mono text-xs text-slate-400">{row.mapped.code}</span>
                        </span>
                      </>
                    ) : row.suggestion ? (
                      <>
                        <Badge tone={row.suggestion.exact ? "info" : "attention"}>
                          {kind === "size"
                            ? row.suggestion.exact
                              ? "Auto from size chart"
                              : "No size chart — sent as typed"
                            : row.suggestion.exact
                              ? "Auto-matched"
                              : "Guess — check"}
                        </Badge>
                        <span className="text-sm text-slate-700">
                          {row.suggestion.label}{" "}
                          {kind === "size" && !row.suggestion.exact ? null : (
                            <span className="font-mono text-xs text-slate-400">{row.suggestion.code}</span>
                          )}
                        </span>
                        {kind !== "size" ? (
                          <Button onClick={() => save(row.shopifyValue, row.suggestion!.code, row.suggestion!.label)}>Confirm</Button>
                        ) : null}
                      </>
                    ) : (
                      <Badge tone="critical">{kind === "size" ? "Not in this type's size chart — map it" : "No match — map it"}</Badge>
                    )}
                    <Button onClick={() => setEditing(isEditing ? null : rowKey)}>{row.mapped ? "Change" : "Map"}</Button>
                    {row.mapped ? <Button onClick={() => clear(row.shopifyValue)}>Clear</Button> : null}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    {text.listCode ? (
                      <>
                        <TextField
                          label={text.searchLabel}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={text.searchPlaceholder}
                        />
                        <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white">
                          {loading ? (
                            <div className="p-3"><SkeletonLine /></div>
                          ) : results.length === 0 ? (
                            <p className="p-3 text-sm text-slate-500">No values match.</p>
                          ) : (
                            results.map((v) => (
                              <button
                                key={v.code}
                                onClick={() => save(row.shopifyValue, v.code, v.label)}
                                className="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-brand-50"
                              >
                                <span className="text-slate-800">{v.label}</span>
                                <span className="font-mono text-xs text-slate-400">{v.code}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    ) : null}
                    {text.allowFreeText || !text.listCode ? (
                      <div className="mt-3 flex flex-wrap items-end gap-2">
                        <div className="w-64">
                          <TextField
                            label={text.listCode ? "…or type a value yourself" : "Decathlon size value"}
                            value={freeText}
                            onChange={(e) => setFreeText(e.target.value)}
                            placeholder={`e.g. ${row.shopifyValue}`}
                          />
                        </div>
                        <Button variant="primary" onClick={() => freeText.trim() && save(row.shopifyValue, freeText.trim())}>
                          Save
                        </Button>
                      </div>
                    ) : null}
                    <div className="mt-2">
                      <Button onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function Mappings() {
  // Any mapping change re-runs the readiness check and refreshes the other sections (a size chart
  // chosen on a product type changes what every size of that type resolves to).
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  return (
    <div>
      <PageHeader
        title="Mappings"
        subtitle="Tell the app how your Shopify catalogue lines up with Decathlon's categories and controlled values."
      />
      <ReadinessSection refreshKey={refreshKey} />
      <UntypedSection onChange={bump} refreshKey={refreshKey} />
      <CategorySection onChange={bump} refreshKey={refreshKey} />
      <KindSection kind="brand" onChange={bump} refreshKey={refreshKey} />
      <KindSection kind="color" onChange={bump} refreshKey={refreshKey} />
      <KindSection kind="size" onChange={bump} refreshKey={refreshKey} />
      <ValueSection />
    </div>
  );
}
