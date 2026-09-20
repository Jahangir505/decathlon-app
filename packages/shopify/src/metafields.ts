/**
 * `custom.decathlon_category` is the metafield packages/shopify's PRODUCT_WITH_VARIANTS_QUERY reads
 * to know which Decathlon (Mirakl H11) category a product belongs to (packages/sync/src/adapters
 * throws a clear error when it's missing). Without a metafield *definition*, merchants can only set
 * it through Shopify admin's generic metafield editor, typing the exact namespace/key/type by hand —
 * creating the definition once makes it show up as a normal labeled field on the product editor.
 */
export const DECATHLON_CATEGORY_METAFIELD_NAMESPACE = "custom";
export const DECATHLON_CATEGORY_METAFIELD_KEY = "decathlon_category";

export const METAFIELD_DEFINITION_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface MetafieldDefinitionCreateResponse {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string } | null;
    userErrors: Array<{ field: string[] | null; message: string; code: string }>;
  };
}

/**
 * Shopify only shows a metafield definition inline on the product editor page ("Product metafields"
 * card) if it's pinned — otherwise merchants have to know to click "View all" to find it at all
 * (confirmed live: the definition existed but the product page still showed "No metafields pinned").
 * Pinning is a separate mutation from creation, not a create-time option.
 */
export const METAFIELD_DEFINITION_PIN_MUTATION = /* GraphQL */ `
  mutation PinMetafieldDefinition($definitionId: ID!) {
    metafieldDefinitionPin(definitionId: $definitionId) {
      pinnedDefinition {
        id
        pinnedPosition
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface MetafieldDefinitionPinResponse {
  metafieldDefinitionPin: {
    pinnedDefinition: { id: string; pinnedPosition: number | null } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

export const METAFIELD_DEFINITIONS_QUERY = /* GraphQL */ `
  query FindMetafieldDefinition($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 1, namespace: $namespace, key: $key, ownerType: $ownerType) {
      edges {
        node {
          id
          pinnedPosition
        }
      }
    }
  }
`;

export interface MetafieldDefinitionsQueryResponse {
  metafieldDefinitions: {
    edges: Array<{ node: { id: string; pinnedPosition: number | null } }>;
  };
}

export const DECATHLON_CATEGORY_METAFIELD_DEFINITION_INPUT = {
  name: "Decathlon Category",
  namespace: DECATHLON_CATEGORY_METAFIELD_NAMESPACE,
  key: DECATHLON_CATEGORY_METAFIELD_KEY,
  description: "The Decathlon Partner (Mirakl) category code this product should be listed under — required to sync this product to Decathlon.",
  type: "single_line_text_field",
  ownerType: "PRODUCT",
};

export const DECATHLON_ATTRIBUTES_METAFIELD_KEY = "decathlon_attributes";

/**
 * Per-product values for Decathlon attributes that Shopify has no field for — e.g. the sport
 * (`SPORT_ALL`, required for every product and inherited from the category tree) or a category's own
 * size/type list. A JSON object of Decathlon attribute code -> value; packages/sync resolves each
 * value by name or code against Decathlon's own value lists and rejects unknown codes/values with a
 * clear per-product error.
 */
export const DECATHLON_ATTRIBUTES_METAFIELD_DEFINITION_INPUT = {
  name: "Decathlon Attributes",
  namespace: DECATHLON_CATEGORY_METAFIELD_NAMESPACE,
  key: DECATHLON_ATTRIBUTES_METAFIELD_KEY,
  description:
    'Extra Decathlon attribute values this product needs that Shopify has no field for, as JSON of attribute code to value — e.g. {"SPORT_ALL": "indoor cycling", "SIZE_CPN_12": "M"}. Values are matched against Decathlon\'s own lists.',
  type: "json",
  ownerType: "PRODUCT",
};

/** Every definition this app creates + pins on a shop, in the order they should appear. */
export const DECATHLON_METAFIELD_DEFINITIONS = [
  DECATHLON_CATEGORY_METAFIELD_DEFINITION_INPUT,
  DECATHLON_ATTRIBUTES_METAFIELD_DEFINITION_INPUT,
];
