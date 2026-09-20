/**
 * Internal normalized models — the only shapes that cross between the Decathlon adapter,
 * the sync engine, and the Shopify adapter. See docs/architecture.md §3.
 */

export interface NormalizedAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
  countryCode: string;
  provinceCode?: string;
  phone?: string;
}

export interface NormalizedCustomer {
  externalId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/**
 * Lookup key for a shop's explicit "this Shopify option value means this Decathlon code" decision.
 * Lives here, in the dependency-free package, because both the repository that builds the map and
 * the product-import builder that reads it must agree on it exactly — and the builder must not pull
 * Prisma in at runtime just to hash a string.
 */
export function attributeValueKey(attributeCode: string, shopifyValue: string): string {
  return `${attributeCode}\u0000${shopifyValue.trim().toLowerCase()}`;
}

export interface NormalizedVariant {
  externalId?: string; // decathlonOfferId once listed
  /** Shopify variant gid — set when this model originates from Shopify (product/offer sync
   *  direction). ProductMapping is keyed by (shopId, shopifyVariantId), not sku, so the engine needs
   *  this to write mapping rows back; it's absent for variants normalized from a Decathlon order. */
  shopifyVariantId?: string;
  sku: string;
  ean?: string;
  price: number;
  currency: string;
  inventoryQuantity: number;
  optionValues?: Record<string, string>; // e.g. { Size: "M", Color: "Blue" }
}

export interface NormalizedProduct {
  externalId?: string; // decathlonProductId once listed
  shopSku: string;
  title: string;
  description?: string;
  brand?: string;
  categoryCode?: string; // Decathlon hierarchy (H11) code — resolved from productType if not set per-product
  /** Shopify's own product type, matched against the shop's CategoryMapping rules when the product
   *  carries no `custom.decathlon_category` override of its own. */
  productType?: string;
  images: string[];
  variants: NormalizedVariant[];
  attributes?: Record<string, string>;
}

export interface NormalizedOrderItem {
  decathlonOrderLineId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  taxAmount?: number;
  discountAmount?: number;
}

export interface NormalizedOrder {
  externalId: string; // decathlonOrderId
  status: string; // raw Decathlon order_state_code
  currency: string;
  createdAt: string;
  customer?: NormalizedCustomer;
  shippingAddress?: NormalizedAddress;
  billingAddress?: NormalizedAddress;
  items: NormalizedOrderItem[];
  totalAmount?: number;
  shippingAmount?: number;
}

export interface NormalizedShipment {
  orderExternalId: string;
  carrierCode?: string;
  carrierName?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shippedAt?: string;
}

export interface NormalizedRefund {
  orderExternalId: string;
  orderLineIds: string[];
  amount: number;
  currency: string;
  reason?: string;
}
