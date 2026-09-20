import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { Badge, Card, PageHeader, SkeletonLine } from "../components/ui";

interface DashboardSummary {
  decathlonConnected: boolean;
  lastCatalogSyncAt: string | null;
  products: { total: number; synced: number; failed: number; pending: number; unmapped: number };
  totalOrdersSynced: number;
  recentOrders: unknown[];
  recentSyncJobs: unknown[];
}

export function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DashboardSummary>("/api/dashboard/summary")
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Decathlon Partner synchronization overview" />

      {error ? (
        <Card className="mb-6 border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load dashboard: {error}</p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-sm font-medium text-slate-500">Decathlon connection</p>
          <div className="mt-3">
            {summary ? (
              <Badge tone={summary.decathlonConnected ? "success" : "critical"}>
                {summary.decathlonConnected ? "Connected" : "Not connected"}
              </Badge>
            ) : (
              <SkeletonLine className="w-24" />
            )}
          </div>
        </Card>

        <Card>
          <p className="text-sm font-medium text-slate-500">Products synced</p>
          {summary ? (
            <p className="mt-3 text-2xl font-semibold text-slate-900">
              {summary.products.synced}
              <span className="text-base font-normal text-slate-400"> / {summary.products.total}</span>
            </p>
          ) : (
            <SkeletonLine className="mt-3 w-16" />
          )}
        </Card>

        <Card>
          <p className="text-sm font-medium text-slate-500">Products failed</p>
          {summary ? (
            <p className={`mt-3 text-2xl font-semibold ${summary.products.failed > 0 ? "text-red-600" : "text-slate-900"}`}>
              {summary.products.failed}
            </p>
          ) : (
            <SkeletonLine className="mt-3 w-16" />
          )}
        </Card>

        <Card>
          <p className="text-sm font-medium text-slate-500">Last catalog sync</p>
          {summary ? (
            <p className="mt-3 text-sm font-medium text-slate-900">
              {summary.lastCatalogSyncAt ? new Date(summary.lastCatalogSyncAt).toLocaleString() : "Never"}
            </p>
          ) : (
            <SkeletonLine className="mt-3 w-32" />
          )}
        </Card>
      </div>

      {summary ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <p className="text-sm font-medium text-slate-500">Total order sync</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{summary.totalOrdersSynced}</p>
          </Card>
          <Card>
            <p className="text-sm font-medium text-slate-500">Pending</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{summary.products.pending}</p>
          </Card>
          <Card>
            <p className="text-sm font-medium text-slate-500">Unmapped</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{summary.products.unmapped}</p>
          </Card>
          <Card>
            <p className="text-sm font-medium text-slate-500">Recent sync jobs</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{summary.recentSyncJobs.length}</p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
