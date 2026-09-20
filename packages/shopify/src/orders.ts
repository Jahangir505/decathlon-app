/**
 * Order creation — the Shopify-side write for order import (Decathlon -> Shopify). Decathlon
 * captures payment before this app ever sees the order (docs/api-mapping.md §0: "Order acceptance"),
 * so every imported order is created as already financially PAID; no checkout/payment flow runs
 * through Shopify. Fulfillment is intentionally NOT set here — fulfillment/refund push-back to
 * Decathlon is a separate, deferred pass (see the plan's "Fulfillment/refund push-back" note).
 */

export const ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation OrderCreate($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface OrderCreateAddressInput {
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

// MoneyBagInput's two legs are NOT "shop's currency twice" — shopMoney is the amount in the
// shop's own currency, presentmentMoney is the amount in the currency actually shown/charged to
// the customer (Decathlon's order currency here). We don't do real FX conversion, so shopMoney
// reuses the raw amount under the shop's currency code rather than a converted figure.
export interface OrderCreateLineItemPriceSet {
  shopMoney: { amount: string; currencyCode: string };
  presentmentMoney: { amount: string; currencyCode: string };
}

export type OrderCreateLineItemInput =
  | { variantId: string; quantity: number; priceSet: OrderCreateLineItemPriceSet }
  | { title: string; quantity: number; priceSet: OrderCreateLineItemPriceSet };

export interface OrderCreateOrderInput {
  email?: string;
  // "The shop-facing currency for the order" per Shopify's docs — this must be the shop's own
  // currency, NOT Decathlon's order currency. The foreign/customer currency goes in
  // presentmentCurrency instead; mixing these two up is exactly what produces orderCreate's
  // "Line items currency must be provided..." userError regardless of what line items carry.
  currency: string;
  presentmentCurrency: string;
  financialStatus: "PAID";
  lineItems: OrderCreateLineItemInput[];
  shippingAddress?: OrderCreateAddressInput;
  billingAddress?: OrderCreateAddressInput;
  tags?: string[];
  note?: string;
}

export interface OrderCreateResponse {
  orderCreate: {
    order: { id: string; name: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}
