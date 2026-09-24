import { DecathlonApiError, DecathlonOutcomeUnknownError, DecathlonRateLimitError } from "@shopify-decathlon/shared";

export interface DecathlonHttpClientOptions {
  /** e.g. https://decathlonbelgium-preprod.mirakl.net/ — see docs/api-mapping.md §0 */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Called after every request (success or failure) for ApiRequestLog persistence — must mask secrets. */
  onRequestComplete?: (info: RequestCompleteInfo) => void;
}

export interface RequestCompleteInfo {
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  attempt: number;
  error?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Some Mirakl endpoints (OR24, OR29) require Content-Length: 0 with no body — see docs/api-mapping.md */
  emptyBody?: boolean;
  /**
   * P44/P45/OF03 (import error/success reports) are documented as CSV, not JSON — UNCONFIRMED, see
   * docs/api-mapping.md §4. Defaults to "json"; pass "text" to skip response.json() and get the raw
   * body back as a string instead.
   */
  responseType?: "json" | "text";
  /**
   * "rate-limit-only" is for writes that must never be applied twice (OR28 refunds, ST01 shipments):
   * only a 429 is retried, because only a 429 guarantees Decathlon did nothing. Anything else that
   * leaves the outcome unknown (timeout, network error, 5xx) throws DecathlonOutcomeUnknownError
   * instead of resending.
   */
  retryPolicy?: "default" | "rate-limit-only";
}

export interface MultipartFile {
  /** Form field name Decathlon expects the import file under — UNCONFIRMED, see docs/api-mapping.md §4 item 7. */
  fieldName: string;
  filename: string;
  content: string;
  contentType: string;
}

const RETRYABLE_STATUS = new Set([429, 502, 503]);

/**
 * Thin fetch wrapper implementing:
 *  - Authorization header (`Authorization: <API_KEY>`, no `Bearer` prefix — confirmed against a
 *    live production call 2026-09-14, see docs/api-mapping.md §0)
 *  - exponential backoff on 429/502/503 (2s, 4s, 8s, 16s, 32s — capped at maxRetries)
 *  - timeout
 *  - request/response logging hook with secrets already excluded from what's passed to the hook
 */
export class DecathlonHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onRequestComplete?: (info: RequestCompleteInfo) => void;

  constructor(options: DecathlonHttpClientOptions) {
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.onRequestComplete = options.onRequestComplete;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const url = this.buildUrl(path, opts.query);
    const safeOnly = opts.retryPolicy === "rate-limit-only";

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      const start = Date.now();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
          Authorization: this.apiKey,
          Accept: "application/json",
        };
        let body: string | undefined;
        if (opts.body !== undefined) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(opts.body);
        } else if (opts.emptyBody) {
          headers["Content-Length"] = "0";
        }

        const response = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timeout);

        const durationMs = Date.now() - start;
        this.onRequestComplete?.({ method, url, status: response.status, durationMs, attempt });

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          if (attempt > this.maxRetries) {
            throw new DecathlonRateLimitError(path, Number.isFinite(retryAfter) ? retryAfter : undefined);
          }
          await this.wait(this.backoffMs(attempt, retryAfter));
          continue;
        }

        if (safeOnly && response.status >= 500) {
          throw new DecathlonOutcomeUnknownError(`${method} ${path}`, `HTTP ${response.status}`);
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt <= this.maxRetries) {
          await this.wait(this.backoffMs(attempt));
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new DecathlonApiError(
            `Decathlon API request failed: ${method} ${path} -> ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
            path,
            response.status,
            text,
          );
        }

        if (response.status === 204) {
          return undefined as T;
        }
        if (opts.responseType === "text") {
          return (await response.text()) as unknown as T;
        }
        return (await response.json()) as T;
      } catch (err) {
        lastError = err;
        const durationMs = Date.now() - start;
        this.onRequestComplete?.({
          method,
          url,
          durationMs,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });

        if (err instanceof DecathlonApiError) throw err;
        if (safeOnly) throw new DecathlonOutcomeUnknownError(`${method} ${path}`, err);
        if (attempt > this.maxRetries) break;
        await this.wait(this.backoffMs(attempt));
      }
    }

    throw new DecathlonApiError(
      `Decathlon API request failed after ${attempt} attempt(s): ${method} ${path}`,
      path,
      undefined,
      lastError,
    );
  }

  /**
   * P41/OF01 reject a JSON body with 415 — they need a multipart/form-data file upload instead (see
   * docs/api-mapping.md §4 item 7). Shares request()'s retry/backoff/logging behavior but can't reuse
   * its body-building since FormData must set its own multipart Content-Type (with boundary) rather
   * than the JSON one.
   */
  async requestMultipart<T>(
    path: string,
    file: MultipartFile,
    query?: RequestOptions["query"],
    /** Extra plain form fields sent alongside the file (e.g. P41's `operator_format`). */
    fields?: Record<string, string>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      const start = Date.now();

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const form = new FormData();
        form.set(file.fieldName, new Blob([file.content], { type: file.contentType }), file.filename);
        for (const [name, value] of Object.entries(fields ?? {})) form.set(name, value);

        // No Content-Type header here — fetch sets `multipart/form-data; boundary=...` itself from
        // the FormData body, and overriding it manually would drop the boundary and break parsing.
        const headers: Record<string, string> = { Authorization: this.apiKey, Accept: "application/json" };

        const response = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
        clearTimeout(timeout);

        const durationMs = Date.now() - start;
        this.onRequestComplete?.({ method: "POST", url, status: response.status, durationMs, attempt });

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          if (attempt > this.maxRetries) {
            throw new DecathlonRateLimitError(path, Number.isFinite(retryAfter) ? retryAfter : undefined);
          }
          await this.wait(this.backoffMs(attempt, retryAfter));
          continue;
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt <= this.maxRetries) {
          await this.wait(this.backoffMs(attempt));
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new DecathlonApiError(
            `Decathlon API request failed: POST ${path} -> ${response.status}`,
            path,
            response.status,
            text,
          );
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err;
        const durationMs = Date.now() - start;
        this.onRequestComplete?.({
          method: "POST",
          url,
          durationMs,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });

        if (err instanceof DecathlonApiError) throw err;
        if (attempt > this.maxRetries) break;
        await this.wait(this.backoffMs(attempt));
      }
    }

    throw new DecathlonApiError(
      `Decathlon API request failed after ${attempt} attempt(s): POST ${path}`,
      path,
      undefined,
      lastError,
    );
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private backoffMs(attempt: number, retryAfterSeconds?: number): number {
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds! > 0) {
      return retryAfterSeconds! * 1000;
    }
    return Math.min(2 ** attempt * 1000, 32_000);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
