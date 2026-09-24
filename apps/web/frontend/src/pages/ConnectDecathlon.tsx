import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Banner, Button, Card, Checkbox, PageHeader, Select, TextField } from "../components/ui";

export interface ConnectionStatus {
  configured: boolean;
  environment?: "PRODUCTION" | "PREPROD";
  baseUrl?: string;
  status?: "NOT_CONFIGURED" | "CONNECTED" | "FAILED";
  lastTestedAt?: string | null;
}

export interface SyncConfig {
  autoProductSyncEnabled: boolean;
  productSyncScope: "ALL" | "SELECTED";
  autoOfferSyncEnabled: boolean;
  autoOrderImportEnabled: boolean;
  orderImportIntervalMinutes: number;
  priceMarkupPercent: number | null;
  priceDiscountPercent: number | null;
  defaultCurrency: string;
  manufacturerEmail: string | null;
  fallbackBrandName: string | null;
  refundReasonCode: string | null;
  setupCompletedAt?: string | null;
}

export const ENVIRONMENT_BASE_URLS: Record<string, string> = {
  PREPROD: "https://decathlonbelgium-preprod.mirakl.net/",
  PRODUCTION: "https://marketplace-decathlon-eu.mirakl.net/",
};

// Decathlon's refund reasons (RE01 `GET /api/reasons/REFUND`, read live 2026-09-21).
const REFUND_REASON_OPTIONS = [
  { label: "Automatic — Out of stock before shipping, Item returned after", value: "" },
  { label: "15 — Out of stock", value: "15" },
  { label: "16 — Cancelled by the client prior to shipping", value: "16" },
  { label: "17 — Item returned", value: "17" },
  { label: "18 — Item not received", value: "18" },
  { label: "19 — Agreement found with the vendor", value: "19" },
];

export const CURRENCY_OPTIONS = [
  { label: "EUR — Euro", value: "EUR" },
  { label: "GBP — British Pound", value: "GBP" },
  { label: "USD — US Dollar", value: "USD" },
];

export function ConnectDecathlon() {
  const [environment, setEnvironment] = useState<"PREPROD" | "PRODUCTION">("PREPROD");
  const [baseUrl, setBaseUrl] = useState(ENVIRONMENT_BASE_URLS.PREPROD);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(null);
  const [savingSyncConfig, setSavingSyncConfig] = useState(false);
  const [savedSyncConfig, setSavedSyncConfig] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncNowResult, setSyncNowResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [syncingProductsNow, setSyncingProductsNow] = useState(false);
  const [syncProductsNowResult, setSyncProductsNowResult] = useState<
    { ok: true; queued: number; skippedNoCategory: number } | { ok: false; error: string } | null
  >(null);

  useEffect(() => {
    apiGet<ConnectionStatus>("/api/connections/decathlon").then(setStatus).catch(() => undefined);
    apiGet<SyncConfig>("/api/sync-configuration").then(setSyncConfig).catch(() => undefined);
  }, []);

  async function handleSaveSyncConfig() {
    if (!syncConfig) return;
    setSavingSyncConfig(true);
    setSavedSyncConfig(false);
    try {
      const updated = await apiPost<SyncConfig>("/api/sync-configuration", syncConfig);
      setSyncConfig(updated);
      setSavedSyncConfig(true);
    } finally {
      setSavingSyncConfig(false);
    }
  }

  async function handleSyncNow() {
    setSyncingNow(true);
    setSyncNowResult(null);
    try {
      await apiPost("/api/sync-configuration/sync-now");
      setSyncNowResult({ ok: true });
    } catch (err) {
      setSyncNowResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSyncingNow(false);
    }
  }

  async function handleSyncProductsNow() {
    setSyncingProductsNow(true);
    setSyncProductsNowResult(null);
    try {
      const result = await apiPost<{ queued: number; skippedNoCategory: number }>("/api/sync-configuration/sync-products-now");
      setSyncProductsNowResult({ ok: true, ...result });
    } catch (err) {
      setSyncProductsNowResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSyncingProductsNow(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; error?: string }>("/api/connections/decathlon", {
        apiKey,
        environment,
        baseUrl,
      });
      setTestResult(result);
      const refreshed = await apiGet<ConnectionStatus>("/api/connections/decathlon");
      setStatus(refreshed);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Connect Decathlon Partner"
        subtitle="Enter the API key from your Mirakl Personal Settings → API Key tab"
      />

      <div className="space-y-6">
        <Card>
          <div className="space-y-4">
            <Select
              label="Environment"
              options={[
                { label: "Preprod / Sandbox", value: "PREPROD" },
                { label: "Production", value: "PRODUCTION" },
              ]}
              value={environment}
              onChange={(e) => {
                const env = e.target.value as "PREPROD" | "PRODUCTION";
                setEnvironment(env);
                setBaseUrl(ENVIRONMENT_BASE_URLS[env]);
              }}
            />
            <TextField label="API Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" />
            <TextField
              label="API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="off"
              helpText="Generated in Mirakl Personal Settings → API Key. Stored encrypted, never shown again."
            />
            <Button variant="primary" loading={saving} onClick={handleSave} disabled={!apiKey}>
              Test Connection
            </Button>
          </div>
        </Card>

        {testResult ? (
          <Banner tone={testResult.ok ? "success" : "critical"}>
            {testResult.ok ? "Connection successful." : `Connection failed: ${testResult.error}`}
          </Banner>
        ) : null}

        {status?.configured ? (
          <Card>
            <h3 className="text-sm font-semibold text-slate-900">Current status</h3>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Status</dt>
                <dd className="font-medium text-slate-900">{status.status}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Environment</dt>
                <dd className="font-medium text-slate-900">{status.environment}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Last tested</dt>
                <dd className="font-medium text-slate-900">
                  {status.lastTestedAt ? new Date(status.lastTestedAt).toLocaleString() : "Never"}
                </dd>
              </div>
            </dl>
          </Card>
        ) : null}

        {syncConfig ? (
          <Card>
            <h3 className="text-sm font-semibold text-slate-900">Automatic sync</h3>
            <div className="mt-4 space-y-3">
              <Checkbox
                label={
                  syncConfig.productSyncScope === "SELECTED"
                    ? "Automatically push changes to my selected products to Decathlon"
                    : "Automatically push product changes to Decathlon"
                }
                checked={syncConfig.autoProductSyncEnabled}
                onChange={(checked) => setSyncConfig({ ...syncConfig, autoProductSyncEnabled: checked })}
              />
              <p className="-mt-1 ml-6 text-xs text-slate-500">
                {syncConfig.productSyncScope === "SELECTED" ? "Only products you chose" : "All active products"} — change this on the{" "}
                <a href="#/products" className="font-medium text-brand-600 hover:underline">
                  Products
                </a>{" "}
                page.
              </p>
              <Checkbox
                label="Automatically push price/stock changes to Decathlon"
                checked={syncConfig.autoOfferSyncEnabled}
                onChange={(checked) => setSyncConfig({ ...syncConfig, autoOfferSyncEnabled: checked })}
              />
              <Checkbox
                label="Automatically import Decathlon orders"
                checked={syncConfig.autoOrderImportEnabled}
                onChange={(checked) => setSyncConfig({ ...syncConfig, autoOrderImportEnabled: checked })}
              />
            </div>

            <div className="mt-4">
              <Select
                label="Order import check interval"
                options={[
                  { label: "Every 5 minutes", value: "5" },
                  { label: "Every 10 minutes", value: "10" },
                  { label: "Every 15 minutes", value: "15" },
                  { label: "Every 30 minutes", value: "30" },
                ]}
                value={String(syncConfig.orderImportIntervalMinutes)}
                onChange={(e) => setSyncConfig({ ...syncConfig, orderImportIntervalMinutes: Number(e.target.value) })}
                disabled={!syncConfig.autoOrderImportEnabled}
              />
            </div>

            <hr className="my-6 border-slate-200" />

            <h3 className="text-sm font-semibold text-slate-900">Pricing</h3>
            <p className="mt-1 text-xs text-slate-500">
              Applied when pushing your Shopify prices to Decathlon offers. Markup and discount stack —
              leave either blank to skip it.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <TextField
                label="Markup %"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={syncConfig.priceMarkupPercent ?? ""}
                onChange={(e) =>
                  setSyncConfig({
                    ...syncConfig,
                    priceMarkupPercent: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
              <TextField
                label="Discount %"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={syncConfig.priceDiscountPercent ?? ""}
                onChange={(e) =>
                  setSyncConfig({
                    ...syncConfig,
                    priceDiscountPercent: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
              <Select
                label="Default currency"
                options={CURRENCY_OPTIONS}
                value={syncConfig.defaultCurrency}
                onChange={(e) => setSyncConfig({ ...syncConfig, defaultCurrency: e.target.value })}
              />
            </div>

            <hr className="my-6 border-slate-200" />

            <h3 className="text-sm font-semibold text-slate-900">Product compliance</h3>
            <p className="mt-1 text-xs text-slate-500">
              Decathlon requires an EU GPSR manufacturer contact email on every product it lists —
              this is the same value for all your products, not something Shopify tracks per product.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Manufacturer email"
                type="email"
                placeholder="compliance@yourbrand.com"
                value={syncConfig.manufacturerEmail ?? ""}
                onChange={(e) => setSyncConfig({ ...syncConfig, manufacturerEmail: e.target.value === "" ? null : e.target.value })}
              />
              <TextField
                label="Fallback brand"
                placeholder="e.g. DECATHLON"
                value={syncConfig.fallbackBrandName ?? ""}
                onChange={(e) => setSyncConfig({ ...syncConfig, fallbackBrandName: e.target.value === "" ? null : e.target.value })}
                helpText="Used only when a product's Shopify vendor doesn't match a real Decathlon brand — lets sync go through instead of hard-failing."
              />
            </div>

            <hr className="my-6 border-slate-200" />

            <h3 className="text-sm font-semibold text-slate-900">Refunds &amp; cancellations</h3>
            <p className="mt-1 text-xs text-slate-500">
              Decathlon collects the customer's payment, so every refund or cancellation you make on a
              Decathlon order in Shopify is sent to Decathlon, which refunds the customer.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Refund reason sent to Decathlon"
                options={REFUND_REASON_OPTIONS}
                value={syncConfig.refundReasonCode ?? ""}
                onChange={(e) => setSyncConfig({ ...syncConfig, refundReasonCode: e.target.value === "" ? null : e.target.value })}
              />
            </div>

            <div className="mt-6 flex items-center gap-3">
              <Button variant="primary" loading={savingSyncConfig} onClick={handleSaveSyncConfig}>
                Save sync settings
              </Button>
              <Button loading={syncingNow} onClick={handleSyncNow}>
                Sync orders now
              </Button>
              <Button loading={syncingProductsNow} onClick={handleSyncProductsNow}>
                Sync products now
              </Button>
              {savedSyncConfig ? <span className="text-sm text-emerald-600">Saved.</span> : null}
            </div>

            {syncNowResult ? (
              <div className="mt-4">
                <Banner tone={syncNowResult.ok ? "success" : "critical"}>
                  {syncNowResult.ok
                    ? "Order import queued — check Sync Logs shortly for the result."
                    : `Failed to queue sync: ${syncNowResult.error}`}
                </Banner>
              </div>
            ) : null}

            {syncProductsNowResult ? (
              <div className="mt-4">
                <Banner tone={syncProductsNowResult.ok ? "success" : "critical"}>
                  {syncProductsNowResult.ok
                    ? `Queued ${syncProductsNowResult.queued} active${syncConfig.productSyncScope === "SELECTED" ? " selected" : ""} product${syncProductsNowResult.queued === 1 ? "" : "s"} for sync` +
                      (syncProductsNowResult.skippedNoCategory > 0
                        ? ` — skipped ${syncProductsNowResult.skippedNoCategory} without a Decathlon category set.`
                        : ".") +
                      " Draft and archived products are never imported. Check Sync Logs shortly for results."
                    : `Failed to queue product sync: ${syncProductsNowResult.error}`}
                </Banner>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
