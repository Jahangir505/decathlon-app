/**
 * Rows -> CSV, for the multipart file P41/OF01 require (docs/api-mapping.md §4 item 7: both reject
 * a JSON body with 415 — Mirakl's bulk-import convention is a CSV/XML file upload instead).
 *
 * CONFIRMED live 2026-09-18 via P42's transformation_error_report (which echoes back exactly what
 * Decathlon's parser read from our submitted file): the delimiter must be **semicolon**, not comma.
 * Every column — including the always-present, always-required `category` — showed up as
 * unrecognized ("1004|The category could not be identified") on every single attempt regardless of
 * which columns/values were sent, which stopped making sense as a column-naming or value problem
 * once the same failure persisted across multiple different real categories. Decathlon's own
 * generated CSVs (this error report, VL11/PM11-adjacent exports) are all semicolon-delimited too —
 * comma-delimited input was most likely being read as one single unrecognized column.
 */
export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";

  const columns = Array.from(rows.reduce((set, row) => {
    for (const key of Object.keys(row)) set.add(key);
    return set;
  }, new Set<string>()));

  const lines = [columns.map(escapeCsvField).join(";")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCsvField(formatCsvValue(row[col]))).join(";"));
  }
  return lines.join("\r\n");
}

function formatCsvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join("|"); // e.g. image URLs — Mirakl's multi-value convention
  return String(value);
}

function escapeCsvField(field: string): string {
  if (/[";\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
