import pino, { type Logger } from "pino";
import { maskSecrets } from "./mask";

export interface LogContext {
  shopId?: string;
  correlationId?: string;
  syncId?: string;
  jobId?: string;
  requestId?: string;
  [key: string]: unknown;
}

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.apiKey",
  "*.apiKeyEncrypted",
  "*.accessToken",
  "*.shopifyAccessToken",
  "*.password",
];

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: redactPaths, censor: "***REDACTED***" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/** Structured event logger matching the requirement's example shape (event/shopId/status/...). */
export function logEvent(
  logger: Logger,
  event: string,
  context: LogContext,
  extra?: Record<string, unknown>,
) {
  logger.info({ event, ...context, ...maskSecrets(extra ?? {}) });
}
