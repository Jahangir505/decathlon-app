import type { NormalizedAddress, NormalizedCustomer, NormalizedOrder, NormalizedOrderItem, NormalizedProduct, NormalizedVariant } from "@shopify-decathlon/shared";
import { ValidationError, attributeValueKey } from "@shopify-decathlon/shared";
import type {
  DecathlonAttribute,
  DecathlonOrderDto,
  DecathlonValueListEntry,
  OfferImportRequest,
  OfferImportRow,
  ProductImportRequest,
  ProductImportRow,
  RawPaginatedResponse,
} from "@shopify-decathlon/decathlon";
import { findValueListEntry, findValueListEntryFuzzy, requiredAttributesForCategory } from "@shopify-decathlon/decathlon";
import { computeOfferPrice, clampQuantity } from "../pricing";

export interface ProductImportContext {
  /** PM11, cached wholesale per shop — see SyncEngine.warmAttributeCache. */
  attributes: DecathlonAttribute[];
  /** VL11 entries for every list the required/overridden attributes reference — see SyncEngine.warmValueListCache. */
  valueLists: DecathlonValueListEntry[];
  /** H11 ancestors of the product's category, root-first (ancestorCodesFor). Mirakl attributes are
   *  inherited down the tree, so required attributes attached to any of these apply here too. */
  ancestorCodes: string[];
  /** Seller-wide GPSR manufacturer contact email (SyncConfiguration.manufacturerEmail) — Decathlon
   *  requires this on every product row and there's no per-product Shopify source for it. */
  manufacturerEmail?: string | null;
  /** SyncConfiguration.fallbackBrandName — used only when a product's Shopify vendor doesn't match
   *  any Decathlon brand (exactly or via a loose substring match). */
  fallbackBrandName?: string | null;
  /** The shop's explicit Shopify-value -> Decathlon-code decisions, keyed by attributeValueKey.
   *  Checked before any name/label matching: a merchant who has mapped "Navy" to a specific
   *  Decathlon colour means that one, and a fuzzy match must not quietly override it. */
  valueMappings?: Map<string, { decathlonCode: string }>;
  /** Shopify option names that hold colour / size (case-insensitive). See optionRoleNames. */
  colorOptionNames?: string[];
  sizeOptionNames?: string[];
  /** The product type's rule from the Mappings page: default gender and size chart. */
  typeRule?: { productType: string; gender?: string | null; sizeChart?: string | null };
}

/** Decathlon's size vocabulary (see SIZE_VALUE_LISTS in docs): the retired t-shirt and shoe lists,
 *  which between them hold every size chart for tops and footwear. Loaded when a type has a chart. */
export const SIZE_VALUE_LISTS = ["size_cpn_7", "size_cpn_4"];
export const GENDER_ATTRIBUTE_CODE = "Gender_apparel";

/** "M (Z349: SIZE MEN TOP)" -> { chart: "Z349", chartName: "SIZE MEN TOP", value: "M" }. */
export function parseSizeEntry(e: { code: string; label: string }): { chart: string; chartName?: string; value: string } {
  const m = e.label.match(/^(.*?)\s*\((Z\d+):\s*([^)]*)\)\s*$/);
  return { chart: e.code.split("_")[0]!, chartName: m?.[3]?.trim(), value: (m?.[1] ?? e.label).trim() };
}

/**
 * The code in one Decathlon size chart for a Shopify size, or undefined. Tries, in order:
 *   1. the chart's value equals the Shopify value ("M" -> "M (Z349: SIZE MEN TOP)"),
 *   2. an EU size ("42" / "EU 42" -> "UK 8 - EU 42"),
 *   3. a US shoe size, converted to UK (men: UK = US - 1, women: UK = US - 2) -> "UK 7 - EU 41".
 * Among ties the shortest code wins (charts list some sizes twice, e.g. "Z349_M" and "Z349_M.").
 */
export function matchSizeInChart(entries: DecathlonValueListEntry[], chart: string, shopifyValue: string): DecathlonValueListEntry | undefined {
  const inChart = entries.filter((e) => e.code.startsWith(`${chart}_`));
  if (inChart.length === 0) return undefined;
  const v = shopifyValue.trim().toLowerCase();
  const val = (e: DecathlonValueListEntry) => parseSizeEntry(e).value.toLowerCase();
  const pick = (f: (e: DecathlonValueListEntry) => boolean) =>
    inChart.filter(f).sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code))[0];
  const token = (n: string) => n.replace(".", "[.,]");

  // "XXL" and "2XL" are the same size; charts use one or the other.
  const aliases = new Set([v]);
  const xs = v.match(/^(x+)(s|l)$/);
  if (xs && xs[1]!.length >= 2) aliases.add(`${xs[1]!.length}x${xs[2]}`);
  const nx = v.match(/^(\d)x(s|l)$/);
  if (nx) aliases.add(`${"x".repeat(Number(nx[1]))}${nx[2]}`);
  const exact = pick((e) => aliases.has(val(e)));
  if (exact) return exact;

  const eu = v.match(/^(?:eu\s*)?(\d+(?:[.,]5)?)$/)?.[1];
  if (eu) {
    const re = new RegExp(`\\beu\\s*${token(eu)}(?![\\d.,/-])`);
    const hit = pick((e) => re.test(val(e)));
    if (hit) return hit;
  }

  const us = v.match(/^us\s*(\d+(?:[.,]5)?)$/)?.[1];
  if (us) {
    const women = /women/i.test(parseSizeEntry(inChart[0]!).chartName ?? "");
    const uk = String(Number(us.replace(",", ".")) - (women ? 2 : 1));
    const re = new RegExp(`\\buk\\s*${token(uk)}(?![\\d.,/-])`);
    const hit = pick((e) => re.test(val(e)));
    if (hit) return hit;
  }
  return undefined;
}

/** Decathlon attribute a variant's Shopify size is sent as. Its value list for most categories
 *  isn't published to sellers (PM11 attaches it only to service categories), but Decathlon's own
 *  transformed file carries a SIZE column for apparel and footwear, so it is the field to fill. */
export const SIZE_ATTRIBUTE_CODE = "SIZE";
/** Attribute code under which explicit vendor -> brand decisions are stored (AttributeValueMapping). */
export const BRAND_ATTRIBUTE_CODE = "brandName";

/** The Shopify option names treated as colour / size: the shop's configured name, else the usual ones. */
export function optionRoleNames(config: { colorOptionName?: string | null; sizeOptionName?: string | null }): {
  colorOptionNames: string[];
  sizeOptionNames: string[];
} {
  const split = (v: string | null | undefined, fallback: string[]) =>
    v?.trim() ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback;
  return {
    colorOptionNames: split(config.colorOptionName, ["color", "colour"]),
    sizeOptionNames: split(config.sizeOptionName, ["size"]),
  };
}

/** The variant's value for the first option whose name is one of `names` (case-insensitive). */
export function optionValueFor(variant: NormalizedVariant, names: string[] | undefined): string | undefined {
  if (!names?.length) return undefined;
  for (const [name, value] of Object.entries(variant.optionValues ?? {})) {
    if (names.includes(name.trim().toLowerCase()) && value.trim()) return value.trim();
  }
  return undefined;
}

/** LIST attributes must map to one of Decathlon's own list entries: an explicit mapping the merchant
 *  configured first, then an exact code/label match, then a loose substring match. Anything that
 *  isn't a LIST attribute passes through as text. */
function resolveAttributeValue(
  attr: DecathlonAttribute,
  value: string,
  valueLists: DecathlonValueListEntry[],
  valueMappings?: Map<string, { decathlonCode: string }>,
): string | undefined {
  // LIST_MULTIPLE_VALUES too: PM11 defines SPORT_ALL as that type on some branches (e.g. 100000), and
  // a label passed through unresolved is rejected at transformation (2006 "not in the possible values").
  if (!attr.type.startsWith("LIST") || !attr.valuesList) return value;
  const mapped = valueMappings?.get(attributeValueKey(attr.code, value));
  if (mapped) return mapped.decathlonCode;
  const match =
    findValueListEntry(valueLists, attr.valuesList, value) ?? findValueListEntryFuzzy(valueLists, attr.valuesList, value);
  return match?.code;
}

/**
 * CONFIRMED live 2026-09-20: `productTitle-*` is capped at 80 characters — a 99-character title came
 * back as `2004|The 'productTitle-en_GB' attribute must have a maximum of 80 characters`. Shopify
 * titles routinely run longer than that, so they are trimmed at a word boundary rather than being
 * rejected outright; the untruncated title still goes to `mainTitle`/`webcatchline-*` (same value,
 * no 80-char warning observed on those) and the full text remains in the long description.
 */
const MAX_PRODUCT_TITLE_LENGTH = 80;

function truncateTitle(title: string): string {
  if (title.length <= MAX_PRODUCT_TITLE_LENGTH) return title;
  const clipped = title.slice(0, MAX_PRODUCT_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

/** GTIN check-digit validation (EAN-8 / UPC-A / EAN-13 / GTIN-14). Decathlon rejects `ean_codes`
 *  that fail it ("2019|... must be a valid product reference: EAN-8 UPC EAN-13", confirmed live), so
 *  fail fast here with a clear message instead of burning an async import round trip. */
function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.padStart(14, "0").split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * NormalizedProduct/Variant -> Decathlon P41 request, one row per Shopify variant (Decathlon lists
 * each shop_sku as its own product). Sent with operator_format=true (see client.ts), so only PM11
 * attribute codes mean anything — CONFIRMED live 2026-09-18: generic Mirakl columns (description,
 * brand, images, category_code...) were simply dropped from Decathlon's transformed file. shop_sku is
 * kept because Decathlon echoes every submitted column back in its transformation report and
 * parseReportText keys on it; label only satisfies ProductImportRow's shape.
 */
export function buildProductImportPayload(
  rows: Array<{ product: NormalizedProduct; variant: NormalizedVariant }>,
  context: ProductImportContext,
): ProductImportRequest {
  const products: ProductImportRow[] = rows.map(({ product, variant }) => {
    if (!product.categoryCode) {
      // Should be unreachable — normalizeShopifyProduct already throws before this point.
      throw new ValidationError(`Product ${product.title} (sku ${variant.sku}) has no categoryCode`);
    }

    const row: ProductImportRow = { shop_sku: variant.sku, category_code: product.categoryCode, label: product.title };
    const missing: string[] = [];

    // Localized title/description attributes are global TEXT attributes that Decathlon script-
    // validates per sales channel ("The product title and the webcatchline must be filled in ...",
    // confirmed live). Fill every locale from the single Shopify text — non-English locales get the
    // English copy, which a merchant can override per attribute code via custom.decathlon_attributes.
    for (const attr of context.attributes) {
      if (attr.hierarchyCode !== "") continue;
      if (attr.code.startsWith("productTitle-")) {
        row[attr.code] = truncateTitle(product.title);
      } else if (attr.code === "mainTitle" || attr.code.startsWith("webcatchline-")) {
        row[attr.code] = product.title;
      } else if (attr.code.startsWith("longDescription-")) {
        row[attr.code] = product.description ?? product.title;
      }
    }

    // Merchant overrides (the custom.decathlon_attributes JSON metafield) win over anything derived.
    // An unknown code is an error rather than silently ignored — it's almost certainly a typo.
    for (const [code, value] of Object.entries(product.attributes ?? {})) {
      const attr = context.attributes.find((a) => a.code === code);
      if (!attr) {
        missing.push(`"${code}" in the "Decathlon Attributes" metafield isn't a Decathlon attribute code`);
        continue;
      }
      const resolved = resolveAttributeValue(attr, value, context.valueLists, context.valueMappings);
      if (resolved === undefined) {
        missing.push(`${attr.label} (${attr.code}) — "${value}" isn't one of Decathlon's "${attr.valuesList}" values`);
      } else {
        row[attr.code] = resolved;
      }
    }

    // Everything Decathlon requires for this category (including attributes inherited from ancestor
    // categories) that hasn't been supplied yet. The handful of global ones map onto data this app
    // already has; the rest is surfaced as a clear, synchronous error naming exactly what's missing
    // and where to set it, rather than a row Decathlon would reject asynchronously.
    for (const attr of requiredAttributesForCategory(context.attributes, product.categoryCode, context.ancestorCodes)) {
      if (row[attr.code] !== undefined && row[attr.code] !== "") continue;
      switch (attr.code) {
        case "category":
          row.category = product.categoryCode;
          break;
        case "ProductIdentifier":
          row.ProductIdentifier = variant.sku;
          break;
        case "main_image":
          if (product.images[0]) row.main_image = product.images[0];
          else missing.push(`${attr.label} (${attr.code}) — product has no images`);
          break;
        case "ean_codes":
          if (!variant.ean) missing.push(`${attr.label} (${attr.code}) — variant has no barcode/EAN set`);
          else if (!isValidGtin(variant.ean))
            missing.push(`${attr.label} (${attr.code}) — "${variant.ean}" isn't a valid EAN-8/UPC/EAN-13 (bad check digit)`);
          else row.ean_codes = variant.ean;
          break;
        case "brandName": {
          if (!product.brand) {
            missing.push(`${attr.label} (${attr.code}) — Shopify product has no vendor set`);
            break;
          }
          const list = attr.valuesList;
          // The merchant's explicit vendor -> brand mapping wins outright: the guesses below can be
          // confidently wrong (a vendor "Test Vendor" substring-matched the unrelated brand "test").
          const explicit = context.valueMappings?.get(attributeValueKey(BRAND_ATTRIBUTE_CODE, product.brand));
          if (explicit) {
            row.brandName = explicit.decathlonCode;
            break;
          }
          // Then an exact match on the vendor, then a looser substring match (handles things like
          // "Nike Inc." vs the catalog's "NIKE"), then the configured fallback brand (also tried
          // exact-then-fuzzy) — only after all of that fails is this treated as truly unmappable.
          const match =
            (list && findValueListEntry(context.valueLists, list, product.brand)) ||
            (list && findValueListEntryFuzzy(context.valueLists, list, product.brand)) ||
            (list && context.fallbackBrandName && findValueListEntry(context.valueLists, list, context.fallbackBrandName)) ||
            (list && context.fallbackBrandName && findValueListEntryFuzzy(context.valueLists, list, context.fallbackBrandName));
          if (match) {
            row.brandName = match.code;
          } else {
            missing.push(
              `${attr.label} (${attr.code}) — Shopify vendor "${product.brand}" isn't a recognized Decathlon brand` +
                (context.fallbackBrandName
                  ? ` (fallback brand "${context.fallbackBrandName}" didn't match either)`
                  : ` — set a "Fallback brand" on the Decathlon Connection page to unblock this`),
            );
          }
          break;
        }
        case GENDER_ATTRIBUTE_CODE:
          // Metafield overrides were applied above, so reaching here means none was set: use the
          // product type's gender from the Mappings page.
          if (context.typeRule?.gender) row[GENDER_ATTRIBUTE_CODE] = context.typeRule.gender;
          else
            missing.push(
              `${attr.label} (${attr.code}) — set a Gender for product type "${context.typeRule?.productType ?? product.productType ?? "(none)"}" on the Mappings page`,
            );
          break;
        case "GPSR_MANUFACTURER_EMAIL_ADDRESS":
          if (context.manufacturerEmail) row.GPSR_MANUFACTURER_EMAIL_ADDRESS = context.manufacturerEmail;
          else missing.push(`${attr.label} (${attr.code}) — set "Manufacturer email" on the Decathlon Connection page`);
          break;
        default: {
          // Variant-level list attributes (e.g. a category's size list) can often be matched straight
          // from the variant's own Shopify option values ("M", "Blue") against Decathlon's list.
          // Colour reads only the colour option and size attributes only the size option; anything
          // else still tries every option value.
          const roleNames =
            attr.code === "color" ? context.colorOptionNames : /size/i.test(attr.code) ? context.sizeOptionNames : undefined;
          const candidates = roleNames
            ? [optionValueFor(variant, roleNames)].filter((v): v is string => Boolean(v))
            : Object.values(variant.optionValues ?? {});
          const fromOptions =
            attr.variant && attr.type === "LIST" && attr.valuesList
              ? candidates
                  .map((v) => resolveAttributeValue(attr, v, context.valueLists, context.valueMappings))
                  .find((v): v is string => v !== undefined)
              : undefined;
          if (fromOptions !== undefined) {
            row[attr.code] = fromOptions;
          } else {
            const where = `set it on the product's "Decathlon Attributes" metafield, e.g. {"${attr.code}": "${
              attr.type === "LIST" ? `<one of Decathlon's "${attr.valuesList}" values>` : "..."
            }"}`;
            const variantNote =
              attr.code === "color"
                ? ` (or add a "${context.colorOptionNames?.[0] ?? "Color"}" option to the product, and map its values on the Mappings page)`
                : attr.variant
                  ? " (also matched against each variant's Shopify option values)"
                  : "";
            missing.push(`${attr.label} (${attr.code}) — ${where}${variantNote}`);
          }
        }
      }
    }

    // Size, per variant, from the size option — the shop's explicit Decathlon value if it mapped one,
    // otherwise the Shopify value as-is. A SIZE set in the "Decathlon Attributes" metafield wins.
    // With a size chart on the product type the value must resolve to a code in it: Decathlon
    // silently empties a SIZE it doesn't recognise (confirmed live 2026-09-21), so an unresolved size
    // is reported rather than sent. Without a chart the value is sent as-is, as before.
    const size = optionValueFor(variant, context.sizeOptionNames);
    if (size && (row[SIZE_ATTRIBUTE_CODE] === undefined || row[SIZE_ATTRIBUTE_CODE] === "")) {
      const explicit = context.valueMappings?.get(attributeValueKey(SIZE_ATTRIBUTE_CODE, size))?.decathlonCode;
      const chart = context.typeRule?.sizeChart;
      const fromChart = !explicit && chart ? matchSizeInChart(context.valueLists, chart, size)?.code : undefined;
      if (explicit || fromChart) row[SIZE_ATTRIBUTE_CODE] = explicit ?? fromChart;
      else if (chart) missing.push(`Size "${size}" isn't in size chart ${chart} — map it on the Mappings page or pick another chart`);
      else row[SIZE_ATTRIBUTE_CODE] = size;
    }

    if (missing.length > 0) {
      throw new ValidationError(
        `Product "${product.title}" (sku ${variant.sku}, category ${product.categoryCode}) is missing required Decathlon attributes: ${missing.join("; ")}`,
      );
    }

    return row;
  });
  return { products };
}

/**
 * NormalizedVariant -> Decathlon OF01/OF24 request. UNCONFIRMED shape — see types.ts. Applies the
 * shop's price markup/discount (docs/sync-strategy.md §6) and clamps stock to >= 0 (§8).
 */
export function buildOfferImportPayload(
  rows: NormalizedVariant[],
  config: {
    priceMarkupPercent: number | null;
    priceDiscountPercent: number | null;
    defaultCurrency: string;
    offerStateCode: string;
  },
): OfferImportRequest {
  const offers: OfferImportRow[] = rows.map((variant) => ({
    shop_sku: variant.sku,
    price: computeOfferPrice(variant.price, config.priceMarkupPercent, config.priceDiscountPercent),
    quantity: clampQuantity(variant.inventoryQuantity),
    currency_iso_code: config.defaultCurrency,
    // Mandatory — an offer with no state is rejected outright with "The state of the product is
    // unknown" (CONFIRMED live 2026-09-20; adding it turned a failing OF24 push into
    // lines_in_success: 1, offer_inserted: 1).
    state_code: config.offerStateCode,
    // How Decathlon attaches this offer to a catalogue product. Without a product reference an
    // offer has nothing to sell against, so the EAN is sent whenever the variant has one — this is
    // also what lets a variant whose EAN already exists in Decathlon's catalogue become sellable
    // without going through a P41 product import at all.
    ...(variant.ean ? { product_id: variant.ean, product_id_type: "EAN" } : {}),
  }));
  return { offers };
}

/**
 * Defensively pulls the order array out of an OR11 response regardless of which envelope key it
 * actually uses — UNCONFIRMED, modeled on DR11/RT11's confirmed `{data: [...]}` shape but falls back
 * to `orders` or treating the response itself as the array so this doesn't hard-crash the first time
 * a real response is seen (see the plan's live-validation step).
 */
export function extractOrdersArray(raw: RawPaginatedResponse | unknown): DecathlonOrderDto[] {
  if (Array.isArray(raw)) return raw as DecathlonOrderDto[];
  const obj = raw as { data?: unknown; orders?: unknown } | undefined;
  if (Array.isArray(obj?.data)) return obj!.data as DecathlonOrderDto[];
  if (Array.isArray(obj?.orders)) return obj!.orders as DecathlonOrderDto[];
  return [];
}

/**
 * DecathlonOrderDto -> NormalizedOrder, against the OR11 shape CONFIRMED live 2026-09-21 (see
 * DecathlonOrderDto). The legacy key names are still read as fallbacks, but the confirmed ones win.
 */
export function normalizeDecathlonOrder(dto: DecathlonOrderDto): NormalizedOrder {
  // `order_id` (e.g. `GB5TWXPAN26F-A`) is what every order-scoped call — shipments, refunds —
  // takes. This used to read a non-existent `id` and silently fall back to `commercial_id`, so
  // imported orders were keyed on an id Decathlon's write endpoints don't accept.
  const externalId = dto.order_id ?? asString(dto.id);
  if (!externalId) {
    throw new ValidationError("Decathlon order has no `order_id` — cannot import");
  }

  // Confirmed live 2026-09-18: `currency_iso_code` only ever appears at the order level in a real
  // OR11 response — order_lines carry no currency field of their own. normalizeOrderLine previously
  // defaulted each line to "EUR" independently, which silently mismatched the order's actual
  // currency (e.g. a real GB/GBP order still produced "EUR" line items) and made Shopify's
  // orderCreate reject the order with a presentment-currency userError. Every line must inherit the
  // order's single currency instead.
  const currency = dto.currency_iso_code ?? "EUR";
  const customer = dto.customer;

  return {
    externalId,
    commercialId: dto.commercial_id,
    status: dto.order_state ?? asString(dto.order_state_code) ?? "UNKNOWN",
    currency,
    createdAt: dto.created_date ?? asString(dto.date_created) ?? new Date().toISOString(),
    customer: normalizeCustomer(customer, dto.customer_notification_email),
    // Addresses are nested under `customer` — reading them from the order root (as this used to)
    // imported every order with no shipping address at all.
    shippingAddress: normalizeAddress(customer?.shipping_address ?? dto.shipping_address),
    billingAddress: normalizeAddress(customer?.billing_address ?? dto.billing_address),
    items: (dto.order_lines ?? []).map((line, index) => normalizeOrderLine(line, index, currency)),
    totalAmount: dto.total_price,
    shippingAmount: dto.shipping_price,
  };
}

function normalizeCustomer(raw: unknown, notificationEmail?: string): NormalizedCustomer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    externalId: asString(r.customer_id ?? r.id),
    // OR11 has no customer email; `customer_notification_email` is the marketplace's relay address.
    email: asString(r.email) ?? asString(notificationEmail),
    firstName: asString(r.firstname ?? r.first_name),
    lastName: asString(r.lastname ?? r.last_name),
    phone: asString(r.phone),
  };
}

function normalizeAddress(raw: unknown): NormalizedAddress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const address1 = asString(r.street_1 ?? r.address1 ?? r.street);
  const city = asString(r.city);
  const zip = asString(r.zip_code ?? r.zip ?? r.postal_code);
  // Confirmed live 2026-09-18: Decathlon sends BOTH `country` (alpha-2, e.g. "GB") and
  // `country_iso_code` (alpha-3, e.g. "GBR") on the same address. Shopify's orderCreate
  // countryCode is a CountryCode enum of alpha-2 values only — alpha-3 is rejected outright as an
  // invalid GraphQL variable. `country` must win; `country_iso_code` is kept only as a last resort.
  const countryCode = asString(r.country ?? r.country_code ?? r.country_iso_code);
  if (!address1 || !city || !zip || !countryCode) return undefined; // incomplete — omit rather than guess
  return {
    firstName: asString(r.firstname ?? r.first_name),
    lastName: asString(r.lastname ?? r.last_name),
    company: asString(r.company),
    address1,
    address2: asString(r.street_2 ?? r.address2),
    city,
    zip,
    countryCode,
    provinceCode: asString(r.state ?? r.province_code),
    phone: asString(r.phone),
  };
}

function normalizeOrderLine(raw: unknown, index: number, orderCurrency: string): NormalizedOrderItem {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const quantity = asNumber(r.quantity) ?? 1;
  // `price` is the line TOTAL (confirmed live: quantity 10, price_unit 2, price 20), so using it as
  // the unit price multiplied every multi-quantity line's value by its quantity in Shopify.
  const lineTotal = asNumber(r.price);
  return {
    decathlonOrderLineId: asString(r.order_line_id ?? r.id) ?? `line-${index}`,
    sku: asString(r.offer_sku ?? r.shop_sku ?? r.sku) ?? "",
    title: asString(r.product_title),
    quantity,
    unitPrice: asNumber(r.price_unit) ?? (lineTotal !== undefined ? lineTotal / quantity : 0),
    // Order lines carry no currency field of their own — always the order's single currency.
    currency: orderCurrency,
    taxAmount: asNumber(r.tax_amount),
    discountAmount: asNumber(r.discount_amount ?? r.total_discount),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
}

export interface ParsedReportRow {
  ok: boolean;
  decathlonId?: string;
  error?: string;
  /** Decathlon's reports carry a `warnings` column alongside `errors`, and a row can transform with
   *  0 errors but a warning that is the actual reason it is later refused — e.g. `2021|The attribute
   *  'productTitle-en_GB' does not comply with script validation`, which leaves the product with no
   *  usable title. Dropping warnings (as this parser used to) hid that entirely. */
  warning?: string;
}

/**
 * Lenient CSV parse of a P44/P45/OF03 report (assumed CSV per docs/api-mapping.md, UNCONFIRMED —
 * see the plan's live-validation step). Never throws — an unrecognized format just yields an empty
 * map; the caller always also logs the raw text to SyncLog so a human can read the real columns.
 */
/**
 * CONFIRMED live 2026-09-18: Decathlon's real reports quote every field (`"shop_sku";"category"...`),
 * not just fields that need it — a naive `line.split(delimiter)` leaves the quote characters attached
 * to every value, so e.g. the parsed sku is literally `"TS-BLK-S"` and never matches the real
 * `TS-BLK-S`, silently discarding every real per-line error (confirmed: a correctly-fetched report
 * with real `1004|The category could not be identified` errors produced zero matched rows before this
 * fix). Handles RFC4180-style embedded delimiters/escaped quotes (`""` inside a quoted field) since
 * Decathlon's own values (HTML descriptions, etc.) can contain either.
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function parseReportText(text: string): Map<string, ParsedReportRow> {
  const result = new Map<string, ParsedReportRow>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return result;

  const delimiter = lines[0]!.includes(";") ? ";" : ",";
  const header = splitCsvLine(lines[0]!, delimiter).map((h) => h.trim().toLowerCase());
  // The integration-stage report has no shop_sku column — it identifies each row by the
  // ProductIdentifier this app submits (which it sets to the variant SKU), so accept either.
  const skuIdx = header.findIndex((h) => h.includes("sku") || h === "productidentifier");
  const statusIdx = header.findIndex((h) => h.includes("status") || h.includes("state"));
  const idIdx = header.findIndex((h) => h === "id" || h.includes("product_id") || h.includes("offer_id"));
  // The offer report has BOTH `error-line` (a line number) and `error-message` (the actual text), in
  // that order — matching on "error" alone picks the line number and reports "2" as the failure
  // reason (confirmed live 2026-09-20). Prefer an explicit message column; only fall back to a
  // generic "error" column (the product reports' `errors`) when there is no message column.
  const messageIdx = header.findIndex((h) => h.includes("message"));
  const errorIdx =
    messageIdx >= 0 ? messageIdx : header.findIndex((h) => h.includes("error") && !h.includes("line") && !h.includes("number"));
  const warningIdx = header.findIndex((h) => h.includes("warning"));
  if (skuIdx === -1) return result; // header not recognized — bail rather than guess column positions

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line, delimiter).map((c) => c.trim());
    const sku = cols[skuIdx];
    if (!sku) continue;
    const status = statusIdx >= 0 ? cols[statusIdx] : undefined;
    const error = errorIdx >= 0 ? cols[errorIdx] : undefined;
    const warning = warningIdx >= 0 ? cols[warningIdx] : undefined;
    result.set(sku, {
      ok: !error && (!status || !/error|fail/i.test(status)),
      decathlonId: idIdx >= 0 ? cols[idIdx] : undefined,
      error: error || undefined,
      warning: warning || undefined,
    });
  }
  return result;
}
