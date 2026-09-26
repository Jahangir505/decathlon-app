import { ancestorCodesFor, type DecathlonHierarchy } from "@shopify-decathlon/decathlon";

export interface CategorySuggestion {
  code: string;
  label: string;
  /** Root-to-leaf labels, e.g. "Apparel > Tops > T-shirts" — what the merchant checks before accepting. */
  path: string;
  /** The type and the category name the same thing once plural/punctuation are ignored. */
  exact: boolean;
  score: number;
}

// Words that say who or how, not what — "Mens Puffer Jackets" is still a jacket.
const STOP_WORDS = new Set(["men", "mens", "man", "women", "womens", "woman", "kid", "kids", "boy", "boys", "girl", "girls", "unisex", "and", "for", "the", "of", "with", "adult", "junior"]);

// Retail names that rarely match Decathlon's own wording. Each type word also gets these as
// alternatives; matching on them scores a little lower than the merchant's own word.
const SYNONYMS: Record<string, string[]> = {
  hoodie: ["sweatshirt", "hooded", "hoody"],
  hoody: ["sweatshirt", "hooded", "hoodie"],
  jumper: ["sweater", "pullover", "sweatshirt"],
  sweater: ["jumper", "pullover"],
  tee: ["tshirt"],
  tshirt: ["tee"],
  polo: ["polo shirt"],
  overshirt: ["shirt", "jacket"],
  puffer: ["down", "padded", "quilted"],
  parka: ["jacket", "coat"],
  bomber: ["jacket"],
  trucker: ["jacket", "denim"],
  jogger: ["jogging", "bottom", "trouser", "pant"],
  sweatpant: ["jogging", "bottom", "trouser", "pant"],
  trackpant: ["tracksuit", "bottom", "trouser"],
  track: ["tracksuit"],
  pant: ["trouser", "bottom"],
  trouser: ["pant", "bottom"],
  jean: ["denim", "trouser"],
  cargo: ["trouser", "pant"],
  wind: ["windproof", "windbreaker"],
  short: ["shorts"],
  outfit: ["set", "tracksuit"],
  set: ["tracksuit", "outfit"],
  beanie: ["hat", "cap", "headwear"],
  cap: ["hat", "headwear"],
  boxer: ["underwear", "brief", "trunk"],
  brief: ["underwear", "boxer"],
  fanny: ["bum", "waist", "belt"],
  pack: ["bag"],
  duffel: ["bag", "holdall", "sport"],
  gym: ["sport", "fitness"],
  laptop: ["computer"],
  backpack: ["rucksack", "bag"],
  wallet: ["purse", "card holder"],
};

/** "T-Shirts" -> ["tshirt"], "Puffer Jackets" -> ["puffer", "jacket"]. */
export function categoryWords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "exercise bike (fitness and athletic)" — the bracket is context, not the thing
    .replace(/t-shirt/g, "tshirt")
    .replace(/[^a-z0-9]+/g, " ");
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map(singular)
    .filter((w) => !STOP_WORDS.has(w));
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function wordScore(typeWords: string[], labelWords: string[]): number {
  if (typeWords.length === 0 || labelWords.length === 0) return 0;
  const label = new Set(labelWords);
  let score = 0;
  for (const w of typeWords) {
    if (label.has(w)) score += 1;
    else if ((SYNONYMS[w] ?? []).some((s) => categoryWords(s).every((x) => label.has(x)))) score += 0.7;
  }
  // The last word is the thing itself ("Puffer JACKETS"): matching it matters most.
  const head = typeWords[typeWords.length - 1] ?? "";
  if (label.has(head) || (SYNONYMS[head] ?? []).some((s) => categoryWords(s).every((x) => label.has(x)))) score += 1;
  // Penalise category words the type doesn't explain, so "T-shirts" beats "T-shirt dresses".
  const typeAll = new Set(typeWords.flatMap((w) => [w, ...(SYNONYMS[w] ?? []).flatMap(categoryWords)]));
  const unexplained = labelWords.filter((w) => !typeAll.has(w)).length;
  return score - 0.35 * unexplained;
}

/**
 * Best Decathlon (H11) leaf category for a Shopify product type, by name. `preferredCodes` are the
 * categories the shop already maps other types to: H11 repeats names across sport trees, and a
 * candidate under the same branches as the merchant's existing choices is far more likely right.
 * Null when nothing shares a meaningful word with the type.
 */
export function suggestCategory(productType: string, hierarchies: DecathlonHierarchy[], preferredCodes: string[] = []): CategorySuggestion | null {
  const typeWords = categoryWords(productType);
  if (typeWords.length === 0) return null;

  const byCode = new Map(hierarchies.map((h) => [h.code, h]));
  const parents = new Set(hierarchies.map((h) => h.parentCode));
  const preferredAncestors = new Map<string, number>();
  for (const code of preferredCodes) {
    for (const a of ancestorCodesFor(hierarchies, code)) preferredAncestors.set(a, (preferredAncestors.get(a) ?? 0) + 1);
  }
  const deprecated = (code: string) =>
    [code, ...ancestorCodesFor(hierarchies, code)].some((c) => /do not use/i.test(byCode.get(c)?.label ?? ""));

  let best: (CategorySuggestion & { tiebreak: number }) | null = null;
  for (const h of hierarchies) {
    if (parents.has(h.code) || deprecated(h.code)) continue;
    const labelWords = categoryWords(h.label);
    const exact = labelWords.join(" ") === typeWords.join(" ");
    let score = exact ? 10 : wordScore(typeWords, labelWords);
    if (score < 1.5) continue; // at least the head noun (or a synonym of it) must match
    const ancestors = ancestorCodesFor(hierarchies, h.code);
    const shared = ancestors.reduce((n, a) => n + (preferredAncestors.has(a) ? 1 : 0), 0);
    score += 0.4 * shared;
    const tiebreak = -h.level;
    if (!best || score > best.score || (score === best.score && tiebreak > best.tiebreak)) {
      best = {
        code: h.code,
        label: h.label,
        path: [...ancestors.map((c) => byCode.get(c)?.label ?? c), h.label].join(" > "),
        exact,
        score,
        tiebreak,
      };
    }
  }
  if (!best) return null;
  return { code: best.code, label: best.label, path: best.path, exact: best.exact, score: best.score };
}

/**
 * The list entry whose label best names the same thing as `text` (e.g. product type "T-Shirts" ->
 * the "T-shirt" entry of a category's product-nature list), by the same word matching as
 * suggestCategory. Undefined unless the head word (or a synonym of it) matches.
 */
export function bestLabelMatch<T extends { code: string; label: string }>(text: string, entries: T[]): T | undefined {
  const words = categoryWords(text);
  if (words.length === 0) return undefined;
  let best: { entry: T; score: number } | undefined;
  for (const entry of entries) {
    const labelWords = categoryWords(entry.label);
    const score = labelWords.join(" ") === words.join(" ") ? 10 : wordScore(words, labelWords);
    if (score >= 1.5 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}
