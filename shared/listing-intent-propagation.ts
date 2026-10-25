import { listingIntentLifecycleEvidenceSchema } from "./listing-intent-lifecycle";
import { DROPSHIP_LISTING_ACCESS_RESOLUTIONS } from "./dropship/listing-access";
import { z } from "zod";
const id = z.number().int().positive().max(2_147_483_647);
export const listingIntentDestinationSchema = z
  .object({
    kind: z.enum(["channel", "dropship"]),
    provider: z.string().min(1),
    connectionId: id,
    channelId: id.nullable(),
    vendorId: id.nullable(),
    accountId: z.string().nullable(),
    environment: z.string().nullable(),
    marketplaceId: z.string().nullable(),
    ambiguousConnection: z.boolean(),
  })
  .strict();
export const listingIntentReceiptSchema = z
  .object({
    owner: z.enum(["ebay_listing_sync", "dropship_listing_push"]),
    operationId: z.string().min(1),
    commandKey: z.string().uuid(),
  })
  .strict();
export const listingIntentChangeStatusSchema = z
  .object({
    id: z.string().regex(/^[1-9][0-9]*$/),
    change_id: z.string().regex(/^[1-9][0-9]*$/),
    destination: listingIntentDestinationSchema,
    product_id: id,
    variant_ids: z.array(id).min(1),
    state: z.enum([
      "pending",
      "delivered",
      "needs_review",
      "blocked",
      "waiting_lifecycle",
      "not_applicable",
    ]),
    lifecycle: listingIntentLifecycleEvidenceSchema.nullable().optional(),
    receipt: listingIntentReceiptSchema.nullable(),
    can_retry: z.boolean(),
    last_error_code: z.string().nullable(),
    last_error_message: z.string().nullable(),
    last_error_resolution: z
      .enum(DROPSHIP_LISTING_ACCESS_RESOLUTIONS)
      .nullable(),
    attempt_count: z.number().int().nonnegative(),
    created_at: z.string(),
    updated_at: z.string(),
    source_relation: z.string(),
    changed_fields: z.array(z.string()),
    operation: z.enum(["INSERT", "UPDATE", "DELETE"]),
    before_scope: z.record(z.unknown()).nullable(),
    after_scope: z.record(z.unknown()).nullable(),
    actor_provenance: z.record(z.unknown()),
    source_changes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[1-9][0-9]*$/),
            source_relation: z.string(),
            changed_fields: z.array(z.string()),
            operation: z.enum(["INSERT", "UPDATE", "DELETE"]),
            before_scope: z.record(z.unknown()).nullable(),
            after_scope: z.record(z.unknown()).nullable(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const listingIntentChangePageSchema = z
  .object({
    items: z.array(listingIntentChangeStatusSchema).max(100),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type ListingIntentChangeStatus = z.infer<
  typeof listingIntentChangeStatusSchema
>;
export type ListingIntentChangePage = z.infer<
  typeof listingIntentChangePageSchema
>;
