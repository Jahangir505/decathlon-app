import { useEffect, useState } from "react";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { apiGet, bootstrapSession } from "./api/client";
import { Dashboard } from "./pages/Dashboard";
import { ConnectDecathlon } from "./pages/ConnectDecathlon";
import { Logs } from "./pages/Logs";
import { Mappings } from "./pages/Mappings";
import { Products } from "./pages/Products";
import { Setup } from "./pages/Setup";
import { BoxIcon, CheckCircleIcon, HomeIcon, ListIcon, MapIcon, PlugIcon } from "./components/icons";

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: HomeIcon },
  { path: "/connect", label: "Decathlon Connection", icon: PlugIcon },
  { path: "/products", label: "Products", icon: BoxIcon },
  { path: "/mappings", label: "Mappings", icon: MapIcon },
  { path: "/logs", label: "Sync Logs", icon: ListIcon },
  { path: "/setup", label: "Setup guide", icon: CheckCircleIcon },
];

/** Sends a shop that hasn't finished setup to the wizard, once per app load — the wizard links out
 *  to Mappings, so redirecting on every navigation would trap the merchant. */
function SetupRedirect({ setupDone }: { setupDone: boolean | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [redirected, setRedirected] = useState(false);
  useEffect(() => {
    if (setupDone === false && !redirected) {
      setRedirected(true);
      if (location.pathname !== "/setup") navigate("/setup", { replace: true });
    }
  }, [setupDone, redirected, location.pathname, navigate]);
  return null;
}

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">D</div>
        <span className="text-sm font-semibold text-slate-900">Decathlon Sync</span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const selected = location.pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                selected ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <Icon className={`h-5 w-5 ${selected ? "text-brand-600" : "text-slate-400"}`} />
              {label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  useEffect(() => {
    bootstrapSession()
      .catch((err) => console.error("Failed to bootstrap embedded session", err))
      .then(() => apiGet<{ setupCompletedAt?: string | null }>("/api/sync-configuration"))
      .then((c) => setSetupDone(Boolean(c?.setupCompletedAt)))
      .catch(() => setSetupDone(null))
      .finally(() => setReady(true));
  }, []);

  return (
    <HashRouter>
      <SetupRedirect setupDone={ready ? setupDone : null} />
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto px-8 py-8">
          {ready ? (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/connect" element={<ConnectDecathlon />} />
              <Route path="/products" element={<Products />} />
              <Route path="/mappings" element={<Mappings />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/setup" element={<Setup onComplete={() => setSetupDone(true)} />} />
            </Routes>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Loading…</div>
          )}
        </main>
      </div>
    </HashRouter>
  );
}
