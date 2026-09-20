import { useEffect, useState } from "react";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { bootstrapSession } from "./api/client";
import { Dashboard } from "./pages/Dashboard";
import { ConnectDecathlon } from "./pages/ConnectDecathlon";
import { Logs } from "./pages/Logs";
import { Mappings } from "./pages/Mappings";
import { HomeIcon, ListIcon, MapIcon, PlugIcon } from "./components/icons";

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: HomeIcon },
  { path: "/connect", label: "Decathlon Connection", icon: PlugIcon },
  { path: "/mappings", label: "Mappings", icon: MapIcon },
  { path: "/logs", label: "Sync Logs", icon: ListIcon },
];

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

  useEffect(() => {
    bootstrapSession()
      .catch((err) => console.error("Failed to bootstrap embedded session", err))
      .finally(() => setReady(true));
  }, []);

  return (
    <HashRouter>
      <div className="flex min-h-screen bg-slate-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto px-8 py-8">
          {ready ? (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/connect" element={<ConnectDecathlon />} />
              <Route path="/mappings" element={<Mappings />} />
              <Route path="/logs" element={<Logs />} />
            </Routes>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Loading…</div>
          )}
        </main>
      </div>
    </HashRouter>
  );
}
