import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { Badge, Banner, Button, Card, Checkbox, PageHeader, Select, SkeletonLine, TextField } from "../components/ui";
import { CURRENCY_OPTIONS, ENVIRONMENT_BASE_URLS, type ConnectionStatus, type SyncConfig } from "./ConnectDecathlon";
import type { Readiness } from "./Mappings";
import { ScopeChooser } from "./Products";

const STEPS = ["Connect Decathlon", "Business details", "Check products", "Go live"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * First-run setup wizard. The merchant lands here until they finish it (SyncConfiguration
 * .setupCompletedAt); every value it saves is the same one the Connection and Mappings pages edit,
 * so nothing here is wizard-only state.
 */
export function Setup({ onComplete }: { onComplete: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<number | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [config, setConfig] = useState<SyncConfig | null>(null);

  const refreshStatus = useCallback(() => apiGet<ConnectionStatus>("/api/connections/decathlon").then(setStatus), []);

  useEffect(() => {
    Promise.all([apiGet<ConnectionStatus>("/api/connections/decathlon"), apiGet<SyncConfig>("/api/sync-configuration")])
      .then(([s, c]) => {
        setStatus(s);
        setConfig(c);
        // Resume where the merchant left off.
        setStep(s.status !== "CONNECTED" ? 0 : !c.manufacturerEmail ? 1 : 2);
      })
      .catch(() => setStep(0));
  }, []);

  if (step === null || !config) {
    return (
      <div className="max-w-3xl space-y-3">
        <SkeletonLine className="w-1/3" />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Set up Decathlon Sync" subtitle="Four short steps to connect your store to your Decathlon seller account." />
      <Stepper current={step} onSelect={(i) => i < step && setStep(i)} />

      {step === 0 ? (
        <ConnectStep status={status} onConnected={refreshStatus} onNext={() => setStep(1)} />
      ) : step === 1 ? (
        <BusinessStep config={config} onSaved={setConfig} onBack={() => setStep(0)} onNext={() => setStep(2)} />
      ) : step === 2 ? (
        <ProductsStep onOpenMappings={() => navigate("/mappings")} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      ) : (
        <GoLiveStep
          config={config}
          environment={status?.environment}
          onBack={() => setStep(2)}
          onFinished={(scope) => {
            onComplete();
            navigate(scope === "SELECTED" ? "/products" : "/");
          }}
        />
      )}
    </div>
  );
}

function Stepper({ current, onSelect }: { current: number; onSelect: (i: number) => void }) {
  return (
    <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              disabled={!done}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium ${
                active ? "bg-brand-50 text-brand-700" : done ? "text-slate-700 hover:bg-slate-100" : "text-slate-400"
              } disabled:cursor-default`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                  done ? "bg-emerald-600 text-white" : active ? "bg-brand-600 text-white" : "bg-slate-200 text-slate-500"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepActions({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4">
      {onBack ? <Button onClick={onBack}>Back</Button> : <span />}
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

// ── Step 1 ────────────────────────────────────────────────────────────────────────────────────

function ConnectStep({
  status,
  onConnected,
  onNext,
}: {
  status: ConnectionStatus | null;
  onConnected: () => Promise<void>;
  onNext: () => void;
}) {
  const connected = status?.status === "CONNECTED";
  const [editing, setEditing] = useState(!connected);
  const [environment, setEnvironment] = useState<"PREPROD" | "PRODUCTION">(status?.environment ?? "PRODUCTION");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? ENVIRONMENT_BASE_URLS[status?.environment ?? "PRODUCTION"]);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  async function handleTest() {
    setSaving(true);
    setResult(null);
    try {
      const r = await apiPost<{ ok: boolean; error?: string }>("/api/connections/decathlon", { apiKey, environment, baseUrl });
      setResult(r);
      await onConnected();
      if (r.ok) {
        setApiKey("");
        setEditing(false);
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Connect your Decathlon seller account</h2>
      <p className="mt-1 text-sm text-slate-500">
        Log in to the Decathlon seller portal, click your name at the top right, open <b>Personal settings</b> and then the{" "}
        <b>API key</b> tab. Copy the key and paste it below. It's stored encrypted and never shown again.
      </p>

      {connected && !editing ? (
        <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Badge tone="success">Connected</Badge>
            {status?.environment === "PRODUCTION" ? "Live Decathlon account" : "Decathlon test (preprod) account"}
          </div>
          <Button onClick={() => setEditing(true)}>Use a different key</Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <Select
            label="Account"
            options={[
              { label: "Live — my real Decathlon shop", value: "PRODUCTION" },
              { label: "Test — Decathlon preprod sandbox", value: "PREPROD" },
            ]}
            value={environment}
            onChange={(e) => {
              const env = e.target.value as "PREPROD" | "PRODUCTION";
              setEnvironment(env);
              setBaseUrl(ENVIRONMENT_BASE_URLS[env]);
            }}
          />
          <TextField label="API key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <details className="text-sm text-slate-500">
            <summary className="cursor-pointer select-none">Advanced</summary>
            <div className="mt-3">
              <TextField
                label="API base URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="off"
                helpText="Only change this if Decathlon gave you a different address."
              />
            </div>
          </details>
          <Button variant="primary" loading={saving} disabled={!apiKey.trim()} onClick={handleTest}>
            Test and save
          </Button>
        </div>
      )}

      {result ? (
        <div className="mt-4">
          <Banner tone={result.ok ? "success" : "critical"}>
            {result.ok ? "Connected to Decathlon." : `Decathlon didn't accept this key: ${result.error ?? "unknown error"}`}
          </Banner>
        </div>
      ) : null}

      <StepActions>
        <Button variant="primary" disabled={!connected} onClick={onNext}>
          Next
        </Button>
      </StepActions>
    </Card>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────────────────────────

function BusinessStep({
  config,
  onSaved,
  onBack,
  onNext,
}: {
  config: SyncConfig;
  onSaved: (c: SyncConfig) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailValid = EMAIL_PATTERN.test(draft.manufacturerEmail ?? "");

  async function handleNext() {
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await apiPost<SyncConfig>("/api/sync-configuration", {
          manufacturerEmail: draft.manufacturerEmail,
          fallbackBrandName: draft.fallbackBrandName,
          defaultCurrency: draft.defaultCurrency,
          priceMarkupPercent: draft.priceMarkupPercent,
          priceDiscountPercent: draft.priceDiscountPercent,
        }),
      );
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const percent = (v: string) => (v === "" ? null : Number(v));

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Business details</h2>
      <p className="mt-1 text-sm text-slate-500">Used on every product and offer you send to Decathlon. You can change these later.</p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Manufacturer contact email (required)"
          type="email"
          placeholder="compliance@yourbrand.com"
          value={draft.manufacturerEmail ?? ""}
          onChange={(e) => setDraft({ ...draft, manufacturerEmail: e.target.value || null })}
          helpText="EU product-safety law (GPSR) requires a manufacturer contact on every product Decathlon lists."
        />
        <TextField
          label="Fallback brand"
          placeholder="e.g. your brand name"
          value={draft.fallbackBrandName ?? ""}
          onChange={(e) => setDraft({ ...draft, fallbackBrandName: e.target.value || null })}
          helpText="Used when a product's Shopify vendor isn't a brand Decathlon knows."
        />
        <Select
          label="Currency"
          options={CURRENCY_OPTIONS}
          value={draft.defaultCurrency}
          onChange={(e) => setDraft({ ...draft, defaultCurrency: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Price markup %"
            type="number"
            min="0"
            step="0.01"
            placeholder="0"
            value={draft.priceMarkupPercent ?? ""}
            onChange={(e) => setDraft({ ...draft, priceMarkupPercent: percent(e.target.value) })}
          />
          <TextField
            label="Price discount %"
            type="number"
            min="0"
            step="0.01"
            placeholder="0"
            value={draft.priceDiscountPercent ?? ""}
            onChange={(e) => setDraft({ ...draft, priceDiscountPercent: percent(e.target.value) })}
          />
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <Banner tone="critical">Couldn't save: {error}</Banner>
        </div>
      ) : null}

      <StepActions onBack={onBack}>
        <Button variant="primary" loading={saving} disabled={!emailValid} onClick={handleNext}>
          Save and continue
        </Button>
      </StepActions>
    </Card>
  );
}

// ── Step 3 ────────────────────────────────────────────────────────────────────────────────────

function ProductsStep({ onOpenMappings, onBack, onNext }: { onOpenMappings: () => void; onBack: () => void; onNext: () => void }) {
  const [data, setData] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<Readiness>("/api/mappings/readiness")
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(check, [check]);

  const blocked = data?.products.filter((p) => p.status === "blocked") ?? [];

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Check your products</h2>
      <p className="mt-1 text-sm text-slate-500">
        Decathlon needs a category, brand, colour, size and a valid EAN barcode for every product. On the <b>Mappings</b> page you tell
        the app how your Shopify product types and values match Decathlon's.
      </p>

      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">Checking your active products — this can take a minute…</p>
            <SkeletonLine className="w-1/2" />
          </div>
        ) : error ? (
          <Banner tone="critical">Couldn't check products: {error}</Banner>
        ) : data ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge tone="success">{data.ready} ready</Badge>
              <Badge tone={data.blocked > 0 ? "attention" : "neutral"}>{data.blocked} need attention</Badge>
            </div>
            {blocked.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
                {blocked.slice(0, 5).map((p) => (
                  <li key={p.shopifyProductId} className="px-4 py-3 text-sm">
                    <div className="font-medium text-slate-900">{p.title}</div>
                    <div className="mt-0.5 text-slate-500">{p.problems[0]}</div>
                  </li>
                ))}
                {blocked.length > 5 ? (
                  <li className="px-4 py-3 text-sm text-slate-500">…and {blocked.length - 5} more on the Mappings page.</li>
                ) : null}
              </ul>
            ) : data.ready > 0 ? (
              <Banner tone="success">All your active products are ready for Decathlon.</Banner>
            ) : (
              <Banner tone="info">No active products found yet. You can add products in Shopify and sync them later.</Banner>
            )}
          </div>
        ) : null}
      </div>

      <StepActions onBack={onBack}>
        <Button onClick={check} disabled={loading}>
          Check again
        </Button>
        {blocked.length > 0 ? <Button onClick={onOpenMappings}>Open Mappings</Button> : null}
        <Button variant="primary" onClick={onNext}>
          {blocked.length > 0 ? "Fix later, continue" : "Next"}
        </Button>
      </StepActions>
    </Card>
  );
}

// ── Step 4 ────────────────────────────────────────────────────────────────────────────────────

function GoLiveStep({
  config,
  environment,
  onBack,
  onFinished,
}: {
  config: SyncConfig;
  environment?: "PRODUCTION" | "PREPROD";
  onBack: () => void;
  onFinished: (scope: SyncConfig["productSyncScope"]) => void;
}) {
  const [scope, setScope] = useState(config.productSyncScope);
  const [autoProducts, setAutoProducts] = useState(config.autoProductSyncEnabled);
  const [autoOffers, setAutoOffers] = useState(config.autoOfferSyncEnabled);
  const [autoOrders, setAutoOrders] = useState(config.autoOrderImportEnabled);
  const [syncNow, setSyncNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish() {
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/sync-configuration", {
        productSyncScope: scope,
        autoProductSyncEnabled: autoProducts,
        autoOfferSyncEnabled: autoOffers,
        autoOrderImportEnabled: autoOrders,
      });
      if (syncNow && scope === "ALL") await apiPost("/api/sync-configuration/sync-products-now");
      await apiPost("/api/sync-configuration/complete-setup");
      onFinished(scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">Choose what syncs automatically</h2>
      <p className="mt-1 text-sm text-slate-500">You can change any of these later on the Decathlon Connection page.</p>

      <h3 className="mt-4 text-sm font-medium text-slate-900">Which products go to Decathlon?</h3>
      <div className="mt-2">
        <ScopeChooser value={scope} onChange={setScope} />
      </div>

      <div className="mt-5 space-y-3">
        <Checkbox label="Send product changes from Shopify to Decathlon" checked={autoProducts} onChange={setAutoProducts} />
        <Checkbox label="Send price and stock changes from Shopify to Decathlon" checked={autoOffers} onChange={setAutoOffers} />
        <Checkbox label="Import new Decathlon orders into Shopify" checked={autoOrders} onChange={setAutoOrders} />
      </div>

      {autoOrders && environment === "PRODUCTION" ? (
        <div className="mt-4">
          <Banner tone="attention">
            This is your live Decathlon account: real customer orders will start appearing in Shopify within a few minutes of finishing.
          </Banner>
        </div>
      ) : null}

      <hr className="my-5 border-slate-200" />
      {scope === "ALL" ? (
        <>
          <Checkbox label="Send my ready products to Decathlon now" checked={syncNow} onChange={setSyncNow} />
          <p className="ml-6 mt-1 text-xs text-slate-500">Results appear on the Sync Logs page. Decathlon reviews new products before they go on sale.</p>
        </>
      ) : (
        <p className="text-sm text-slate-600">After you finish, you'll pick the products to list on the Products page. Each one is sent as soon as you add it.</p>
      )}

      {error ? (
        <div className="mt-4">
          <Banner tone="critical">Couldn't finish setup: {error}</Banner>
        </div>
      ) : null}

      <StepActions onBack={onBack}>
        <Button variant="primary" loading={saving} onClick={handleFinish}>
          Finish setup
        </Button>
      </StepActions>
    </Card>
  );
}
