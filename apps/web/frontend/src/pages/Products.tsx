import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api/client";
import { Badge, Banner, Button, Card, EmptyState, PageHeader, SkeletonLine } from "../components/ui";
import type { SyncConfig } from "./ConnectDecathlon";

type ProductSyncScope = "ALL" | "SELECTED";

interface SelectedProductRow {
  shopifyProductId: string;
  title: string;
  addedAt: string;
  status: "SYNCED" | "PENDING" | "FAILED" | "NOT_SYNCED";
  lastSyncedAt: string | null;
  lastError: string | null;
}

const STATUS_BADGES: Record<SelectedProductRow["status"], { tone: "success" | "info" | "critical" | "neutral"; label: string }> = {
  SYNCED: { tone: "success", label: "Synced" },
  PENDING: { tone: "info", label: "Waiting on Decathlon" },
  FAILED: { tone: "critical", label: "Failed" },
  NOT_SYNCED: { tone: "neutral", label: "Not synced yet" },
};

const SCOPE_OPTIONS: Array<{ value: ProductSyncScope; title: string; body: string }> = [
  {
    value: "ALL",
    title: "All products",
    body: "Every active product that has a Decathlon category is sent to Decathlon, including new products you add later.",
  },
  {
    value: "SELECTED",
    title: "Only products I choose",
    body: "Only the products in the list below are sent to Decathlon. Nothing else in your store is touched.",
  },
];

export function ScopeChooser({ value, onChange, disabled }: { value: ProductSyncScope; onChange: (v: ProductSyncScope) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {SCOPE_OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg p-4 ring-1 ring-inset transition ${
              selected ? "bg-brand-50 ring-brand-600" : "bg-white ring-slate-200 hover:bg-slate-50"
            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <input
              type="radio"
              name="productSyncScope"
              className="mt-0.5 h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600"
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            <span>
              <span className="block text-sm font-medium text-slate-900">{opt.title}</span>
              <span className="mt-0.5 block text-xs text-slate-500">{opt.body}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Products() {
  const [scope, setScope] = useState<ProductSyncScope | null>(null);
  const [savingScope, setSavingScope] = useState(false);
  const [rows, setRows] = useState<SelectedProductRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "critical" | "attention"; text: string } | null>(null);

  function loadRows() {
    return apiGet<SelectedProductRow[]>("/api/sync-configuration/selected-products").then(setRows);
  }

  useEffect(() => {
    apiGet<SyncConfig>("/api/sync-configuration")
      .then((c) => setScope(c.productSyncScope))
      .catch(() => undefined);
    loadRows().catch(() => setRows([]));
  }, []);

  async function changeScope(next: ProductSyncScope) {
    const previous = scope;
    setScope(next);
    setSavingScope(true);
    setMessage(null);
    try {
      await apiPost("/api/sync-configuration", { productSyncScope: next });
    } catch (err) {
      setScope(previous);
      setMessage({ tone: "critical", text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSavingScope(false);
    }
  }

  async function addProducts() {
    if (!window.shopify?.resourcePicker) return;
    setMessage(null);
    const picked = await window.shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "add",
      filter: { variants: false, draft: false, archived: false },
    });
    if (!picked || picked.length === 0) return;
    setAdding(true);
    try {
      const result = await apiPost<{ added: number; queued: number; skippedNoCategory: number }>(
        "/api/sync-configuration/selected-products",
        { products: picked.map((p) => ({ shopifyProductId: p.id, title: p.title })) },
      );
      const parts = [`Added ${result.added} product${result.added === 1 ? "" : "s"}.`];
      if (result.queued > 0) parts.push(`${result.queued} sent to Decathlon — check Sync Logs shortly.`);
      if (result.skippedNoCategory > 0)
        parts.push(`${result.skippedNoCategory} have no Decathlon category yet; set one on the Mappings page and they'll sync on their next edit or "Sync products now".`);
      setMessage({ tone: result.skippedNoCategory > 0 ? "attention" : "success", text: parts.join(" ") });
      await loadRows();
    } catch (err) {
      setMessage({ tone: "critical", text: `Couldn't add products: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setAdding(false);
    }
  }

  async function removeProduct(row: SelectedProductRow) {
    setRemoving(row.shopifyProductId);
    try {
      await apiDelete(`/api/sync-configuration/selected-products/${row.shopifyProductId.split("/").pop()}`);
      setRows((current) => current?.filter((r) => r.shopifyProductId !== row.shopifyProductId) ?? null);
    } catch (err) {
      setMessage({ tone: "critical", text: `Couldn't remove: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      <PageHeader title="Products" subtitle="Choose which of your Shopify products are listed on Decathlon." />

      <div className="space-y-6">
        <Card>
          <h3 className="text-sm font-semibold text-slate-900">Which products sync to Decathlon</h3>
          <div className="mt-4">
            {scope ? <ScopeChooser value={scope} onChange={changeScope} disabled={savingScope} /> : <SkeletonLine className="h-20" />}
          </div>
          {scope === "SELECTED" ? (
            <p className="mt-3 text-xs text-slate-500">
              Removing a product here stops future updates to it. It stays listed on Decathlon until you remove it in your Decathlon
              seller account.
            </p>
          ) : null}
        </Card>

        {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}

        {scope === "SELECTED" ? (
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Selected products{rows ? ` (${rows.length})` : ""}
              </h3>
              <Button variant="primary" loading={adding} onClick={addProducts}>
                Add products
              </Button>
            </div>
            {rows && rows.length === 0 ? (
              <EmptyState heading="No products selected">
                Click <strong>Add products</strong> to choose what to list on Decathlon. They're sent as soon as you add them.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {["Product", "Status", "Last synced", ""].map((heading) => (
                        <th key={heading} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {rows === null
                      ? Array.from({ length: 4 }).map((_, i) => (
                          <tr key={i}>
                            <td colSpan={4} className="px-4 py-3">
                              <SkeletonLine />
                            </td>
                          </tr>
                        ))
                      : rows.map((row) => {
                          const badge = STATUS_BADGES[row.status];
                          return (
                            <tr key={row.shopifyProductId}>
                              <td className="px-4 py-3 font-medium text-slate-900">{row.title}</td>
                              <td className="px-4 py-3">
                                <Badge tone={badge.tone}>{badge.label}</Badge>
                                {row.lastError ? <p className="mt-1 max-w-md text-xs text-red-600">{row.lastError}</p> : null}
                              </td>
                              <td className="px-4 py-3 text-slate-500">
                                {row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : "—"}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button loading={removing === row.shopifyProductId} onClick={() => removeProduct(row)}>
                                  Remove
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
