import { z } from "zod";

/**
 * Deliberately permissive Zod schemas — see the note at the top of types.ts. These only assert the
 * minimal shape needed for the sync engine to function (e.g. "there is an import_id string"), and use
 * `.passthrough()` so unknown-but-present fields survive without validation failing on them. Replace
 * with strict schemas once real Decathlon response payloads are available.
 */

// CONFIRMED 2026-09-15 (live, preprod, OF24): import_id comes back as a NUMBER (e.g. 299790), not a
// string as originally guessed — coerce so every caller can keep treating it as a string.
const importIdSchema = z.union([z.string(), z.number()]).transform(String).optional();

export const ImportResultSchema = z
  .object({
    import_id: importIdSchema,
  })
  .passthrough();

export const ImportStatusResultSchema = z
  .object({
    import_id: importIdSchema,
    // OF02 (offer import) shape — CONFIRMED live 2026-09-15.
    status: z.string().optional(),
    has_error_report: z.boolean().optional(),
    lines_read: z.number().optional(),
    lines_in_error: z.number().optional(),
    lines_in_pending: z.number().optional(),
    lines_in_success: z.number().optional(),
    // P42 (product import) shape — CONFIRMED live 2026-09-18, entirely different field names from
    // OF02 above (not a subset) — see types.ts's ImportStatusResult doc comment.
    import_status: z.string().optional(),
    has_new_product_report: z.boolean().optional(),
    has_transformation_error_report: z.boolean().optional(),
    has_transformed_file: z.boolean().optional(),
    transform_lines_read: z.number().optional(),
    transform_lines_in_error: z.number().optional(),
    transform_lines_with_warning: z.number().optional(),
    transform_lines_in_success: z.number().optional(),
    // Stage 2 of a product import — CONFIRMED live 2026-09-20, see types.ts.
    integration_details: z
      .object({
        products_successfully_synchronized: z.number().optional(),
        rejected_products: z.number().optional(),
        invalid_products: z.number().optional(),
        products_with_wrong_identifiers: z.number().optional(),
        products_with_synchronization_issues: z.number().optional(),
        products_not_accepted_in_time: z.number().optional(),
        products_not_synchronized_in_time: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const RawPaginatedResponseSchema = z
  .object({
    total_count: z.number().optional(),
  })
  .passthrough();

/** UNCONFIRMED — see the matching type in types.ts for context. */
export const ProductImportRowSchema = z
  .object({
    shop_sku: z.string(),
    category_code: z.string(),
    label: z.string(),
    description: z.string().optional(),
    ean: z.string().optional(),
    brand: z.string().optional(),
    images: z.array(z.string()).optional(),
  })
  .passthrough();

export const ProductImportRequestSchema = z.object({
  products: z.array(ProductImportRowSchema),
});

/** UNCONFIRMED — see the matching type in types.ts for context. */
export const OfferImportRowSchema = z
  .object({
    shop_sku: z.string(),
    price: z.number(),
    quantity: z.number(),
    currency_iso_code: z.string(),
    state_code: z.string().optional(),
  })
  .passthrough();

export const OfferImportRequestSchema = z.object({
  offers: z.array(OfferImportRowSchema),
});

// `S extends z.ZodTypeAny` + `z.infer<S>` (rather than matching the schema against `z.ZodType<T>`
// directly) so TS reliably resolves T to the schema's OUTPUT type even when a field uses
// `.transform()` (e.g. import_id's number-or-string -> string coercion above) — the more direct
// `z.ZodType<T>` parameter form was observed to bind T to the pre-transform input type instead.
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown, context: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Decathlon API response for ${context} failed validation: ${result.error.message}`);
  }
  return result.data;
}
