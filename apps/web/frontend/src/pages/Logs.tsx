import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { Badge, Card, EmptyState, Modal, PageHeader, Pagination } from "../components/ui";

interface SyncLogRow {
  id: string;
  type: string;
  status: string;
  itemLabel: string | null;
  decathlonId: string | null;
  shopifyId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface LogsResponse {
  items: SyncLogRow[];
  total: number;
}

const STATUS_TONE: Record<string, "success" | "critical" | "attention" | "info"> = {
  SUCCESS: "success",
  FAILED: "critical",
  RETRYING: "attention",
  PROCESSING: "info",
};

const PAGE_SIZE = 20;

export function Logs() {
  const [data, setData] = useState<LogsResponse | null>(null);
  const [page, setPage] = useState(0);
  const [selectedError, setSelectedError] = useState<{ type: string; createdAt: string; message: string } | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<LogsResponse>(`/api/logs?skip=${page * PAGE_SIZE}&take=${PAGE_SIZE}`)
      .then(setData)
      .catch(() => setData({ items: [], total: 0 }));
  }, [page]);

  return (
    <div>
      <PageHeader title="Sync Logs" />

      <Card className="overflow-hidden p-0">
        {data && data.items.length === 0 ? (
          <EmptyState heading="No sync activity yet">
            Once product, order, or fulfillment synchronization runs, results will appear here.
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {["Date", "Type", "Product", "Status", "Decathlon ID", "Error"].map((heading) => (
                      <th key={heading} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {data === null
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i}>
                          <td className="px-4 py-3" colSpan={6}>
                            <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                          </td>
                        </tr>
                      ))
                    : data.items.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-4 py-3 text-slate-600">{new Date(log.createdAt).toLocaleString()}</td>
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">{log.type}</td>
                          <td className="max-w-xs truncate px-4 py-3 text-slate-700" title={log.itemLabel ?? undefined}>
                            {log.itemLabel ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <Badge tone={STATUS_TONE[log.status] ?? "neutral"}>{log.status}</Badge>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-600">{log.decathlonId ?? "—"}</td>
                          <td className="max-w-xs px-4 py-3 text-red-600">
                            {log.errorMessage ? (
                              <button
                                onClick={() =>
                                  setSelectedError({ type: log.type, createdAt: log.createdAt, message: log.errorMessage! })
                                }
                                className="max-w-xs truncate text-left underline decoration-red-300 underline-offset-2 hover:decoration-red-500"
                                title="Click to view full error"
                              >
                                {log.errorMessage}
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPageChange={setPage} />
          </>
        )}
      </Card>

      {selectedError ? (
        <Modal title={`${selectedError.type} error`} onClose={() => setSelectedError(null)}>
          <p className="mb-3 text-xs text-slate-400">{new Date(selectedError.createdAt).toLocaleString()}</p>
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-800">
            {selectedError.message}
          </pre>
        </Modal>
      ) : null}
    </div>
  );
}
