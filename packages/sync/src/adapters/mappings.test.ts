import { describe, expect, it } from "vitest";
import type { DecathlonAttribute, DecathlonValueListEntry } from "@shopify-decathlon/decathlon";
import type { NormalizedProduct, NormalizedVariant } from "@shopify-decathlon/shared";
import { attributeValueKey } from "@shopify-decathlon/shared";
import { buildProductImportPayload, optionRoleNames, optionValueFor, type ProductImportContext } from "./decathlon.adapter";
import { categoryError } from "../engine";

// The attributes every product in 128500's tree needs (as in the live PM11), colour inherited from 100000.
const attr = (code: string, extra: Partial<DecathlonAttribute> = {}): DecathlonAttribute => ({
  code, hierarchyCode: "", label: code, type: "TEXT", required: true, variant: false, ...extra,
});
const ATTRIBUTES: DecathlonAttribute[] = [
  attr("category"), attr("ProductIdentifier"), attr("main_image"), attr("ean_codes"), attr("GPSR_MANUFACTURER_EMAIL_ADDRESS"),
  attr("brandName", { type: "LIST", valuesList: "brandName" }),
  attr("color", { type: "LIST", valuesList: "color", variant: true, hierarchyCode: "100000" }),
];
const VALUES: DecathlonValueListEntry[] = [
  { listCode: "brandName", code: "11109", label: "test" },
  { listCode: "brandName", code: "484", label: "DOMYOS" },
  { listCode: "color", code: "1", label: "BLACK" },
  { listCode: "color", code: "17", label: "MAUVE" },
];

const product = (over: Partial<NormalizedProduct> = {}): NormalizedProduct => ({
  shopSku: "P", title: "Training T-Shirt", brand: "Test Vendor", categoryCode: "128500", productType: "Apparel",
  images: ["https://img/1.jpg"], variants: [], ...over,
});
const variant = (optionValues: Record<string, string>, sku = "SKU-1"): NormalizedVariant => ({
  sku, ean: "2006994081702", price: 10, currency: "EUR", inventoryQuantity: 1, shopifyVariantId: "v1", optionValues,
});
const context = (over: Partial<ProductImportContext> = {}): ProductImportContext => ({
  attributes: ATTRIBUTES, valueLists: VALUES, ancestorCodes: ["100000", "120000", "128000"],
  manufacturerEmail: "c@example.com", ...optionRoleNames({}), ...over,
});
const build = (p: NormalizedProduct, v: NormalizedVariant, c = context()) => buildProductImportPayload([{ product: p, variant: v }], c).products[0]!;
const mappings = (entries: Array<[string, string, string]>) => new Map(entries.map(([a, s, d]) => [attributeValueKey(a, s), { decathlonCode: d }]));

describe("brand mapping", () => {
  it("uses the explicit vendor -> brand mapping over the substring guess", () => {
    const row = build(product(), variant({ Color: "Black" }), context({ valueMappings: mappings([["brandName", "Test Vendor", "484"]]) }));
    expect(row.brandName).toBe("484");
  });

  it("without a mapping still guesses (the behaviour the Mappings page flags as 'Guess — check')", () => {
    expect(build(product(), variant({ Color: "Black" })).brandName).toBe("11109");
  });
});

describe("colour mapping", () => {
  it("reads the colour option only — a size 'Mauve'-like value in another option is ignored", () => {
    // Size "Mauve" would substring-match the colour list; colour must come from the Color option.
    expect(build(product(), variant({ Size: "Mauve", Color: "Black" })).color).toBe("1");
  });

  it("uses the explicit colour mapping", () => {
    const row = build(product(), variant({ Color: "Jet" }), context({ valueMappings: mappings([["color", "Jet", "1"]]) }));
    expect(row.color).toBe("1");
  });

  it("honours a custom colour option name", () => {
    const row = build(product(), variant({ Shade: "Black" }), context(optionRoleNames({ colorOptionName: "Shade" })));
    expect(row.color).toBe("1");
  });

  it("reports a missing colour when there is no colour option, pointing to the Mappings page", () => {
    expect(() => build(product(), variant({ Size: "M" }))).toThrow(/Main color|color.*Mappings page/);
  });
});

describe("size mapping", () => {
  it("sends the Shopify size as SIZE per variant", () => {
    expect(build(product(), variant({ Color: "Black", Size: "M" })).SIZE).toBe("M");
  });

  it("sends the mapped Decathlon size when one is set", () => {
    const row = build(product(), variant({ Color: "Black", Size: "M" }), context({ valueMappings: mappings([["SIZE", "M", "SIZE_M_TOP"]]) }));
    expect(row.SIZE).toBe("SIZE_M_TOP");
  });

  it("lets a SIZE in the Decathlon Attributes metafield win", () => {
    const withSizeAttr = context({ attributes: [...ATTRIBUTES, attr("SIZE", { required: false, variant: true, hierarchyCode: "S-1" })] });
    expect(build(product({ attributes: { SIZE: "One size" } }), variant({ Color: "Black", Size: "M" }), withSizeAttr).SIZE).toBe("One size");
  });

  it("sends no SIZE when the product has no size option", () => {
    expect(build(product(), variant({ Color: "Black" })).SIZE).toBeUndefined();
  });

  it("matches option names case-insensitively", () => {
    expect(optionValueFor(variant({ SIZE: " L " }), ["size"])).toBe("L");
  });
});

describe("category must be specific", () => {
  const tree = [
    { code: "100000", label: "Apparel, Footwear, Accessories", parentCode: "" },
    { code: "130000", label: "Footwear", parentCode: "100000" },
    { code: "132600", label: "Running, athletics, walking footwear", parentCode: "130000" },
  ];
  it("refuses a group", () => expect(categoryError(tree, "100000")).toMatch(/group/));
  it("refuses an unknown code", () => expect(categoryError(tree, "999")).toMatch(/doesn't exist/));
  it("accepts a leaf", () => expect(categoryError(tree, "132600")).toBeUndefined());
});

describe("product type rule: gender and size chart", () => {
  const GENDER_ATTRS = [...ATTRIBUTES, attr("Gender_apparel", { type: "LIST", valuesList: "Gender_apparel", hierarchyCode: "100000" })];
  const SIZE_ENTRIES: DecathlonValueListEntry[] = [
    { listCode: "size_cpn_7", code: "Z349_M", label: "M (Z349: SIZE MEN TOP)" },
    { listCode: "size_cpn_7", code: "Z349_M.", label: "M (Z349: SIZE MEN TOP)" },
    { listCode: "size_cpn_4", code: "Z272_42", label: "UK 8 - EU 42 (Z272: MEN'S SHOE SIZES)" },
    { listCode: "size_cpn_4", code: "Z272_41", label: "UK 7 - EU 41 (Z272: MEN'S SHOE SIZES)" },
    { listCode: "Gender_apparel", code: "2", label: "MEN'S" },
  ];
  const ctx = (typeRule: ProductImportContext["typeRule"], over: Partial<ProductImportContext> = {}) =>
    context({ attributes: GENDER_ATTRS, valueLists: [...VALUES, ...SIZE_ENTRIES], typeRule, ...over });

  it("takes the gender from the product type", () => {
    expect(build(product(), variant({ Color: "Black" }), ctx({ productType: "Apparel", gender: "2" })).Gender_apparel).toBe("2");
  });

  it("lets the product's metafield override the type's gender", () => {
    const row = build(product({ attributes: { Gender_apparel: "MEN'S" } }), variant({ Color: "Black" }), ctx({ productType: "Apparel", gender: "3" }));
    expect(row.Gender_apparel).toBe("2");
  });

  it("says where to set a missing gender", () => {
    expect(() => build(product(), variant({ Color: "Black" }), ctx({ productType: "Apparel" }))).toThrow(
      /Gender for product type "Apparel" on the Mappings page/,
    );
  });

  it("resolves sizes through the type's chart (shortest code of duplicates)", () => {
    expect(build(product(), variant({ Color: "Black", Size: "M" }), ctx({ productType: "Apparel", gender: "2", sizeChart: "Z349" })).SIZE).toBe("Z349_M");
  });

  it("converts US shoe sizes via UK in a men's chart", () => {
    expect(build(product(), variant({ Color: "Black", Size: "US 9" }), ctx({ productType: "Footwear", gender: "2", sizeChart: "Z272" })).SIZE).toBe("Z272_42");
  });

  it("an explicit size mapping beats the chart", () => {
    const row = build(product(), variant({ Color: "Black", Size: "M" }), ctx({ productType: "Apparel", gender: "2", sizeChart: "Z349" }, {
      valueMappings: mappings([["SIZE", "M", "Z349_M."]]),
    }));
    expect(row.SIZE).toBe("Z349_M.");
  });

  it("reports a size the chart doesn't have instead of sending it", () => {
    expect(() => build(product(), variant({ Color: "Black", Size: "Huge" }), ctx({ productType: "Apparel", gender: "2", sizeChart: "Z349" }))).toThrow(
      /Size "Huge" isn't in size chart Z349/,
    );
  });
});

describe("metafield overrides", () => {
  it("resolves a LIST_MULTIPLE_VALUES label to its code (SPORT_ALL is that type on some branches)", () => {
    const c = context({
      attributes: [...ATTRIBUTES, attr("SPORT_ALL", { type: "LIST_MULTIPLE_VALUES", valuesList: "SPORT_ALL", hierarchyCode: "100000" })],
      valueLists: [...VALUES, { listCode: "SPORT_ALL", code: "296", label: "cardio training" }],
    });
    const row = build(product({ attributes: { SPORT_ALL: "cardio training" } }), variant({ Color: "Black" }), c);
    expect(row.SPORT_ALL).toBe("296");
  });
});
