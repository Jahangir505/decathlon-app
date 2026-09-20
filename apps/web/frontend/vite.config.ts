import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // The monorepo's single .env lives at the repo root, three levels up from this file - Vite only
  // looks in its own project folder by default, so VITE_SHOPIFY_API_KEY would otherwise never be seen.
  envDir: resolve(__dirname, "../../.."),
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // bind 0.0.0.0 - required so the shopify app dev tunnel can reach this process
    // `shopify app dev` assigns this process a random port via FRONTEND_PORT and proxies its
    // tunnel to exactly that port - hardcoding 5173 here breaks the CLI (falls back to a different
    // port when 5173 is taken, leaving the CLI's proxy target unreachable). Falls back to 5173 for
    // manual `pnpm dev:frontend` runs where no CLI is involved.
    port: Number(process.env.FRONTEND_PORT) || 5173,
    strictPort: true,
    // The tunnel domain (trycloudflare.com etc.) changes every `shopify app dev` run and isn't
    // knowable in advance; Vite 5.4+ rejects unrecognized Host headers by default, which otherwise
    // shows as a silent blank page when proxied through the CLI's tunnel.
    allowedHosts: true,
    proxy: {
      "/api": {
        // BACKEND_PORT is set by `shopify app dev` alongside FRONTEND_PORT; falls back to the
        // manual dev backend port (.env's PORT) otherwise.
        target: `http://localhost:${process.env.BACKEND_PORT || 3000}`,
        changeOrigin: true,
      },
    },
  },
});
