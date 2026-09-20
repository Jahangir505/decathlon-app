/**
 * PM11 (product attribute schema) / VL11 (attribute value lists) parsing — both endpoints return
 * their FULL catalog-wide dataset regardless of any filter query param (confirmed live 2026-09-18,
 * see client.ts's getProductAttributes/getValueLists), so this module strips each raw response down
 * to the handful of fields packages/sync's product-import payload builder actually needs (the raw
 * PM11 response is ~38MB, almost entirely per-locale label/description translations we don't use)
 * before it gets cached in DecathlonCatalogReference, and does the category filtering client-side.
 */

export interface DecathlonAttribute {
  code: string;
  /** Empty string means the attribute applies to every category, not just this one. */
  hierarchyCode: string;
  label: string;
  type: string;
  required: boolean;
  /** True if this attribute is expected to vary per Shopify variant (e.g. SIZE) rather than be
   *  the same for every variant of a product. */
  variant: boolean;
  /** VL11 value-list code to validate/resolve this attribute's value against, if type is LIST. */
  valuesList?: string;
}

export interface DecathlonValueListEntry {
  listCode: string;
  code: string;
  label: string;
}

export function parseAttributes(raw: unknown): DecathlonAttribute[] {
  const list = (raw as { attributes?: unknown[] } | null)?.attributes ?? [];
  return list.map((entry) => {
    const r = entry as Record<string, unknown>;
    return {
      code: String(r.code ?? ""),
      hierarchyCode: String(r.hierarchy_code ?? ""),
      label: String(r.label ?? r.code ?? ""),
      type: String(r.type ?? "TEXT"),
      required: Boolean(r.required),
      variant: Boolean(r.variant),
      valuesList: r.values_list ? String(r.values_list) : undefined,
    };
  });
}

export interface DecathlonHierarchy {
  code: string;
  label: string;
  level: number;
  /** Empty string at the root. */
  parentCode: string;
}

/** H11 → stripped shape (drops the per-locale label_translations bloat, same idea as parseAttributes). */
export function parseHierarchies(raw: unknown): DecathlonHierarchy[] {
  const list = (raw as { hierarchies?: unknown[] } | null)?.hierarchies ?? [];
  return list.map((entry) => {
    const r = entry as Record<string, unknown>;
    return {
      code: String(r.code ?? ""),
      label: String(r.label ?? r.code ?? ""),
      level: Number(r.level ?? 0),
      parentCode: String(r.parent_code ?? ""),
    };
  });
}

/** Ancestor codes of a category, root-first, NOT including the category itself. Empty if the code
 *  isn't in the tree. Bounded so a corrupt/cyclic tree can't loop forever. */
export function ancestorCodesFor(hierarchies: DecathlonHierarchy[], categoryCode: string): string[] {
  const byCode = new Map(hierarchies.map((h) => [h.code, h]));
  const chain: string[] = [];
  let cur = byCode.get(categoryCode);
  for (let i = 0; cur && cur.parentCode && i < 32; i++) {
    const parent = byCode.get(cur.parentCode);
    if (!parent) break;
    chain.unshift(parent.code);
    cur = parent;
  }
  return chain;
}

/**
 * Every attribute that must be present on a P41 row for this category: global (hierarchyCode ""),
 * the category's own, AND anything attached to an ancestor category — CONFIRMED live 2026-09-18:
 * Mirakl attributes are inherited down the H11 tree (e.g. `SPORT_ALL` is attached to top-level
 * sport-family nodes like `114`, and P41 rejects a category-`12` row without it even though `12`
 * itself declares no such attribute). Callers get the ancestors from ancestorCodesFor.
 */
export function requiredAttributesForCategory(
  all: DecathlonAttribute[],
  categoryCode: string,
  ancestorCodes: string[] = [],
): DecathlonAttribute[] {
  const applicable = new Set(["", categoryCode, ...ancestorCodes]);
  const seen = new Set<string>();
  return all.filter((a) => {
    if (!a.required || !applicable.has(a.hierarchyCode) || seen.has(a.code)) return false;
    seen.add(a.code); // the same code can be attached to several ancestors — one column either way
    return true;
  });
}

export function parseValueLists(raw: unknown): DecathlonValueListEntry[] {
  // CONFIRMED live 2026-09-18: the real key is "values_lists" (plural + underscore), not "value_lists".
  const lists = (raw as { values_lists?: unknown[] } | null)?.values_lists ?? [];
  const entries: DecathlonValueListEntry[] = [];
  for (const listEntry of lists) {
    const l = listEntry as Record<string, unknown>;
    const listCode = String(l.code ?? "");
    const values = (l.values as unknown[] | undefined) ?? [];
    for (const v of values) {
      const value = v as Record<string, unknown>;
      entries.push({
        listCode,
        code: String(value.code ?? value.value ?? ""),
        label: String(value.label ?? value.value ?? value.code ?? ""),
      });
    }
  }
  return entries;
}

export function findValueListEntry(
  entries: DecathlonValueListEntry[],
  listCode: string,
  needle: string,
): DecathlonValueListEntry | undefined {
  const normalized = needle.trim().toLowerCase();
  return entries.find(
    (e) => e.listCode === listCode && (e.code.toLowerCase() === normalized || e.label.toLowerCase() === normalized),
  );
}

/**
 * Second-pass, best-effort match for when the Shopify vendor string doesn't exactly equal a
 * Decathlon value-list label/code (e.g. "Nike Inc." vs the catalog's "NIKE") — tries substring
 * containment both directions before the caller falls back to any configured default. Exact
 * findValueListEntry is tried first by callers since a substring match can be wrong (e.g. "Test
 * Vendor" could spuriously contain-match an unrelated short brand code) — this is a convenience,
 * not a guarantee, and callers should treat it as lower-confidence than an exact hit.
 */
export function findValueListEntryFuzzy(
  entries: DecathlonValueListEntry[],
  listCode: string,
  needle: string,
): DecathlonValueListEntry | undefined {
  const normalized = needle.trim().toLowerCase();
  if (normalized.length < 3) return undefined; // too short to substring-match safely
  return entries.find((e) => {
    if (e.listCode !== listCode) return false;
    const label = e.label.toLowerCase();
    return label.includes(normalized) || normalized.includes(label);
  });
}
