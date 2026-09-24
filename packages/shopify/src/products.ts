/**
 * Product + variant + inventory read queries — the Shopify-side source data for product/offer sync
 * (Shopify -> Decathlon). Deliberately reads via `inventoryItem.inventoryLevels`, not the deprecated
 * `ProductVariant.inventoryQuantity` field, and sums across all locations per docs/sync-strategy.md §8
 * ("sum available quantity across all locations into one stock figure").
 *
 * The Decathlon category (H11 hierarchy code) is resolved from the product's `productType` (or, when
 * that's blank, its Shopify standard category — see effectiveProductType) via the
 * shop's CategoryMapping rules, with a per-product `custom.decathlon_category` metafield overriding
 * it when set. A product that matches neither fails sync with a clear error (see packages/sync).
 */

export const PRODUCT_WITH_VARIANTS_QUERY = /* GraphQL */ `
  query ProductWithVariants($id: ID!) {
    product(id: $id) {
      id
      status
      title
      descriptionHtml
      vendor
      productType
      category {
        name
      }
      images(first: 10) {
        edges {
          node {
            url
          }
        }
      }
      decathlonCategory: metafield(namespace: "custom", key: "decathlon_category") {
        value
      }
      decathlonAttributes: metafield(namespace: "custom", key: "decathlon_attributes") {
        value
      }
      variants(first: 100) {
        edges {
          node {
            id
            sku
            barcode
            price
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
              inventoryLevels(first: 20) {
                edges {
                  node {
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type ShopifyProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

/** Shopify's standard product category (taxonomy), e.g. { name: "T-Shirts" }. */
export interface ShopifyTaxonomyCategory {
  name: string;
}

/**
 * The value category rules are matched against: the merchant's own product type, or — when that's
 * blank, as it is on many imported catalogues — the name of the Shopify standard product category,
 * which Shopify fills in automatically for most products. Empty string when neither is set.
 */
export function effectiveProductType(product: { productType?: string | null; category?: ShopifyTaxonomyCategory | null }): string {
  return (product.productType ?? "").trim() || (product.category?.name ?? "").trim();
}

export interface ShopifyVariantNode {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: {
    id: string;
    inventoryLevels: {
      edges: Array<{ node: { quantities: Array<{ name: string; quantity: number }> } }>;
    };
  };
}

export interface ProductWithVariantsResponse {
  product: {
    id: string;
    /** Only ACTIVE products are ever sent to Decathlon — DRAFT and ARCHIVED are skipped. */
    status: ShopifyProductStatus;
    title: string;
    descriptionHtml: string | null;
    vendor: string | null;
    /** Matched against CategoryMapping.shopifyProductType to resolve the Decathlon category. */
    productType: string | null;
    category: ShopifyTaxonomyCategory | null;
    images: { edges: Array<{ node: { url: string } }> };
    decathlonCategory: { value: string } | null;
    /** JSON object of Decathlon attribute code -> value, for required attributes this app can't derive
     *  from generic Shopify data (e.g. `{"SPORT_ALL": "indoor cycling"}`) — see packages/sync. */
    decathlonAttributes: { value: string } | null;
    variants: { edges: Array<{ node: ShopifyVariantNode }> };
  } | null;
}

/**
 * Paginated product listing used by the "Sync products now" bulk action (apps/web/backend's
 * QueueProducerService.enqueueProductSyncAll). Filtered to ACTIVE products server-side — drafts and
 * archived products are never imported to Decathlon. Walks every active product so it can enqueue a
 * PRODUCT_SYNC job for each one that has the required decathlon_category metafield set, rather than
 * only reacting to future products/update webhooks.
 */
export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query ProductsPage($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          status
          productType
          category {
            name
          }
          decathlonCategory: metafield(namespace: "custom", key: "decathlon_category") {
            value
          }
        }
      }
    }
  }
`;

export interface ProductsPageResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ node: { id: string; status: ShopifyProductStatus; productType: string | null; category: ShopifyTaxonomyCategory | null; decathlonCategory: { value: string } | null } }>;
  };
}

/** Same fields as PRODUCTS_PAGE_QUERY, for the merchant's hand-picked list (productSyncScope
 *  SELECTED). Up to 250 ids per call; a deleted product comes back as null. */
export const PRODUCTS_BY_IDS_QUERY = /* GraphQL */ `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        status
        productType
        category {
          name
        }
        decathlonCategory: metafield(namespace: "custom", key: "decathlon_category") {
          value
        }
      }
    }
  }
`;

export interface ProductsByIdsResponse {
  nodes: Array<ProductsPageResponse["products"]["edges"][number]["node"] | null>;
}

/** Resolves a webhook's numeric inventory_item_id (REST) back to its variant + product (GraphQL). */
export const INVENTORY_ITEMS_TO_VARIANTS_QUERY = /* GraphQL */ `
  query InventoryItemsToVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        variant {
          id
          product {
            id
          }
        }
      }
    }
  }
`;

export interface InventoryItemsToVariantsResponse {
  nodes: Array<{ id: string; variant: { id: string; product: { id: string } } | null } | null>;
}

/** Resolves a batch of variant gids back to their parent product gid — used by offer sync, whose
 *  job payload only carries variant ids, to know which product(s) to re-fetch fresh price/stock from. */
export const VARIANTS_TO_PRODUCTS_QUERY = /* GraphQL */ `
  query VariantsToProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        product {
          id
        }
      }
    }
  }
`;

export interface VariantsToProductsResponse {
  nodes: Array<{ id: string; product: { id: string } } | null>;
}

/**
 * What the Mappings page lists on the Shopify side: each active product's vendor (-> Decathlon
 * brand) and option values (-> Decathlon colour / size). Active only, like everything imported.
 */
export const PRODUCT_FACETS_QUERY = /* GraphQL */ `
  query ProductFacets($cursor: String) {
    products(first: 100, after: $cursor, query: "status:active") {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        productType
        category {
          name
        }
        vendor
        options {
          name
          values
        }
      }
    }
  }
`;

export interface ProductFacetsResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; title: string; productType: string | null; category: ShopifyTaxonomyCategory | null; vendor: string | null; options: Array<{ name: string; values: string[] }> }>;
  };
}

/** Sets the merchant's product type — used by the Mappings page to give untyped products a type in
 *  bulk, so one category rule covers them instead of a metafield per product. */
export const PRODUCT_SET_TYPE_MUTATION = /* GraphQL */ `
  mutation ProductSetType($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        productType
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ProductSetTypeResponse {
  productUpdate: { product: { id: string; productType: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
}
