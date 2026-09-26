import { describe, expect, it } from "vitest";
import { bestLabelMatch, categoryWords, suggestCategory } from "./category-suggest";

// A slice shaped like H11: several trees, repeated names, a retired branch and groups.
const H = [
  { code: "100000", label: "Apparel", level: 1, parentCode: "" },
  { code: "128000", label: "Tops", level: 2, parentCode: "100000" },
  { code: "128500", label: "T-shirts", level: 3, parentCode: "128000" },
  { code: "128600", label: "Sweatshirts", level: 3, parentCode: "128000" },
  { code: "128700", label: "Polo shirts", level: 3, parentCode: "128000" },
  { code: "128800", label: "T-shirt dresses", level: 3, parentCode: "128000" },
  { code: "129000", label: "Jackets", level: 2, parentCode: "100000" },
  { code: "129100", label: "Down jackets", level: 3, parentCode: "129000" },
  { code: "129200", label: "Windbreakers", level: 3, parentCode: "129000" },
  { code: "130000", label: "Bottoms", level: 2, parentCode: "100000" },
  { code: "130100", label: "Jogging bottoms", level: 3, parentCode: "130000" },
  { code: "130200", label: "Trousers", level: 3, parentCode: "130000" },
  { code: "200000", label: "Running", level: 1, parentCode: "" },
  { code: "200100", label: "Running T-shirts", level: 2, parentCode: "200000" },
  { code: "200200", label: "Jackets", level: 2, parentCode: "200000" },
  { code: "300000", label: "Bags", level: 1, parentCode: "" },
  { code: "300100", label: "Bum bags", level: 2, parentCode: "300000" },
  { code: "300200", label: "Backpacks", level: 2, parentCode: "300000" },
  { code: "900000", label: "DO NOT USE - old apparel", level: 1, parentCode: "" },
  { code: "900100", label: "Hoodies", level: 2, parentCode: "900000" },
];

const pick = (type: string, preferred: string[] = []) => suggestCategory(type, H, preferred)?.code ?? null;

describe("categoryWords", () => {
  it("normalises plurals, hyphens and gender words", () => {
    expect(categoryWords("Mens T-Shirts")).toEqual(["tshirt"]);
    expect(categoryWords("Puffer Jackets")).toEqual(["puffer", "jacket"]);
  });
});

describe("suggestCategory", () => {
  it("matches the same name exactly", () => {
    const s = suggestCategory("T-Shirts", H);
    expect(s).toMatchObject({ code: "128500", exact: true, path: "Apparel > Tops > T-shirts" });
  });

  it("never suggests a group or a DO NOT USE category", () => {
    expect(pick("Hoodies")).toBe("128600"); // Sweatshirts via synonym, not the retired "Hoodies"
    expect(pick("Tops")).toBeNull();
  });

  it("uses retail synonyms", () => {
    expect(pick("Puffer Jackets")).toBe("129100");
    expect(pick("Joggers")).toBe("130100");
    expect(pick("Fanny Packs")).toBe("300100");
    expect(pick("Polos")).toBe("128700");
  });

  it("prefers the extra-word-free category", () => {
    expect(pick("T-Shirts")).toBe("128500");
  });

  it("prefers the branch the shop already maps into", () => {
    // Two leaves named "Jackets" exist nowhere as leaves here except Running; with apparel mapped,
    // an apparel jacket leaf wins over the running one.
    expect(pick("Bomber Jackets", ["128500"])).not.toBe("200200");
  });

  it("returns null when nothing shares a word", () => {
    expect(pick("Wallets")).toBeNull();
  });
});

describe("bestLabelMatch", () => {
  const nature = [
    { code: "A", label: "Polo shirt" },
    { code: "B", label: "T-shirt" },
    { code: "C", label: "Tank top" },
  ];
  it("picks the entry named like the product type", () => {
    expect(bestLabelMatch("T-Shirts", nature)?.code).toBe("B");
    expect(bestLabelMatch("Polos", nature)?.code).toBe("A");
    expect(bestLabelMatch("Wallets", nature)).toBeUndefined();
  });
});
