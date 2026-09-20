/**
 * P41/OF01 payload size limits are undocumented (docs/sync-strategy.md §9: "size TBD by real P41
 * payload limits, not yet documented"). 200 is a conservative default pending real confirmation —
 * never build a full-catalogue payload in memory, always chunk.
 */
export const DEFAULT_IMPORT_BATCH_SIZE = 200;

export function chunk<T>(items: T[], size: number = DEFAULT_IMPORT_BATCH_SIZE): T[][] {
  if (size <= 0) throw new Error("chunk: size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
