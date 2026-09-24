declare global {
  interface Window {
    shopify?: {
      idToken: () => Promise<string>;
      /** App Bridge's product picker; resolves undefined when the merchant cancels. */
      resourcePicker: (options: {
        type: "product";
        multiple?: boolean | number;
        action?: "add" | "select";
        filter?: { variants?: boolean; draft?: boolean; archived?: boolean };
      }) => Promise<Array<{ id: string; title: string }> | undefined>;
    };
  }
}

/**
 * Every authenticated call to our own backend attaches the current App Bridge session token as a
 * bearer token — verified server-side by SessionTokenGuard (apps/web/backend/src/auth/session-token.guard.ts).
 */
async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!window.shopify) {
    throw new Error("App Bridge not loaded — is this page running embedded inside Shopify admin?");
  }
  const token = await window.shopify.idToken();

  return fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authorizedFetch(path, { method: "GET" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await authorizedFetch(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await authorizedFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

/** Called once per app load — bootstraps/refreshes the backend's stored offline access token. */
export async function bootstrapSession(): Promise<void> {
  if (!window.shopify) return;
  const token = await window.shopify.idToken();
  await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken: token }),
  });
}
