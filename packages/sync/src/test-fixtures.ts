/**
 * Test fixtures shaped exactly like live preprod responses (docs/api-mapping.md §4 item 13) —
 * field names are real, values are placeholders. Excluded from the build via tsconfig.
 */
import type { DecathlonCarrier, DecathlonOrderDto, DecathlonOrderLineDto } from "@shopify-decathlon/decathlon";

export function orderLine(overrides: Partial<DecathlonOrderLineDto> = {}): DecathlonOrderLineDto {
  return {
    order_line_id: "GB5TEST-A-1",
    order_line_state: "SHIPPING",
    offer_sku: "SKU-1",
    product_title: "Test T-Shirt",
    quantity: 1,
    price: 20,
    price_unit: 20,
    shipping_price: 5,
    total_price: 25,
    can_refund: true,
    refunds: [],
    ...overrides,
  };
}

export function decathlonOrder(overrides: Partial<DecathlonOrderDto> = {}): DecathlonOrderDto {
  return {
    order_id: "GB5TEST-A",
    commercial_id: "GB5TEST",
    order_state: "SHIPPING",
    currency_iso_code: "GBP",
    created_date: "2026-09-20T10:00:00Z",
    customer: {
      customer_id: "cust-1",
      firstname: "Jane",
      lastname: "Doe",
      billing_address: { city: "London", country: "GB", country_iso_code: "GBR", lastname: "Doe", street_1: "1 Test St", zip_code: "N1 1AA" },
      shipping_address: { city: "London", country: "GB", firstname: "Jane", lastname: "Doe", street_1: "1 Test St", street_2: "Flat 2", zip_code: "N1 1AA" },
    },
    customer_notification_email: "relay@example.invalid",
    order_lines: [orderLine()],
    total_price: 25,
    shipping_price: 5,
    ...overrides,
  };
}

/** Subset of the live SH21 list — includes the ambiguous UPS / UPS (UK) pair on purpose. */
export const CARRIERS: DecathlonCarrier[] = [
  { code: "RoyalMail", label: "Royal Mail" },
  { code: "DPDUK", label: "DPD (UK)" },
  { code: "UPS", label: "UPS" },
  { code: "UPSUK", label: "UPS (UK)" },
  { code: "postBE", label: "Bpost (Belgium)" },
  { code: "parcelforceUK", label: "Parcelforce (UK)" },
];
