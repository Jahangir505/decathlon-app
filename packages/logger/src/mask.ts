const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|access[-_]?token|secret|password|cookie)/i;
const REDACTED = "***REDACTED***";

/**
 * Deep-clones a value, replacing any key that looks like a credential with a redacted marker.
 * Used before persisting request/response summaries to SyncLog/ApiRequestLog and before logging.
 */
export function maskSecrets<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
    } else if (val && typeof val === "object") {
      result[key] = maskSecrets(val, seen);
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

/** Masks a raw header string like "Authorization: Bearer abc123" for log lines. */
export function maskHeaderLine(line: string): string {
  return line.replace(/^(authorization|api[-_]?key)\s*:\s*.+$/i, "$1: ***REDACTED***");
}
