/**
 * Product + variant + inventory read queries — the Shopify-side source data for product/offer sync
 * (Shopify -> Decathlon). Deliberately reads via `inventoryItem.inventoryLevels`, not the deprecated
 * `ProductVariant.inventoryQuantity` field, and sums across all locations per docs/sync-strategy.md §8
 * ("sum available quantity across all locations into one stock figure").
 *
 * The Decathlon category (H11 hierarchy code) is resolved from the product's `productType` via the
 * shop's CategoryMapping rules, with a per-product `custom.decathlon_category` metafield overriding
 * it when set. A product that matches neither fails sync with a clear error (see packages/sync).
 */

export const PRODUCT_WITH_VARIANTS_QUERY = /* GraphQL */ `
  query ProductWithVariants($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      productType
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
    title: string;
    descriptionHtml: string | null;
    vendor: string | null;
    /** Matched against CategoryMapping.shopifyProductType to resolve the Decathlon category. */
    productType: string | null;
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
 * QueueProducerService.enqueueProductSyncAll) — walks every product in the shop so it can enqueue a
 * PRODUCT_SYNC job for each one that has the required decathlon_category metafield set, rather than
 * only reacting to future products/update webhooks.
 */
export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query ProductsPage($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          productType
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
    edges: Array<{ node: { id: string; productType: string | null; decathlonCategory: { value: string } | null } }>;
  };
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
