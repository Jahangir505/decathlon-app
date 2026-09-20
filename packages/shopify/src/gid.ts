/** Shopify Admin GraphQL object types this package addresses by gid. */
export type ShopifyGidType = "Product" | "ProductVariant" | "InventoryItem" | "Order" | "Customer";

/** Builds a GraphQL global id, e.g. toGid("Product", 123) -> "gid://shopify/Product/123". */
export function toGid(type: ShopifyGidType, id: string | number): string {
  return `gid://shopify/${type}/${id}`;
}

/** Extracts the trailing numeric id from a GraphQL global id, e.g. "gid://shopify/Product/123" -> "123". */
export function fromGid(gid: string): string {
  const parts = gid.split("/");
  const id = parts[parts.length - 1];
  if (!id) throw new Error(`Not a valid Shopify gid: ${gid}`);
  return id;
}
