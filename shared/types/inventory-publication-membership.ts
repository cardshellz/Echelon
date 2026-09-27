import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775807"),
    "Revision exceeds PostgreSQL bigint",
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z
  .array(id)
  .min(1)
  .max(500)
  .refine(
    (values) => new Set(values).size === values.length,
    "Variant ids must be unique",
  );

export const publicationMembershipModeSchema = z.enum([
  "whole_product",
  "explicit",
]);
export const inspectPublicationMembershipSchema = z
  .object({
    channelId: id,
    channelConnectionId: id,
    productVariantIds: ids,
  })
  .strict();
export const publicationMembershipChangeSchema = z
  .object({ productVariantId: id, included: z.boolean() })
  .strict();
export const reviewPublicationMembershipSchema = z
  .object({
    publicationTargetId: id,
    expectedTargetRevision: revision,
    changes: z
      .array(publicationMembershipChangeSchema)
      .min(1)
      .max(500)
      .refine(
        (values) =>
          new Set(values.map((value) => value.productVariantId)).size ===
          values.length,
        "Each variant may appear once",
      ),
  })
  .strict();
export const applyPublicationMembershipSchema =
  reviewPublicationMembershipSchema
    .extend({
      expectedReviewHash: hash,
      idempotencyKey: z.string().trim().min(1).max(120),
    })
    .strict();
export const publicationMembershipBlockerSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    action: z.enum([
      "configure_inventory",
      "review_mapping",
      "review_source",
      "review_variant",
      "hold_and_verify_zero",
      "refresh",
      "review_existing_scope",
    ]),
    productVariantId: id.nullable(),
  })
  .strict();
export const publicationMembershipInspectionSchema = z
  .object({
    channelId: id,
    channelConnectionId: id,
    authority: z.enum(["legacy", "canonical"]),
    authorityRevision: revision,
    targets: z.array(
      z
        .object({
          publicationTargetId: id,
          revision,
          mode: publicationMembershipModeSchema,
          state: z.enum(["disabled", "preview", "live"]),
          externalScopeId: z.string(),
          sourceReady: z.boolean(),
          variants: z.array(
            z
              .object({
                productVariantId: id,
                included: z.boolean(),
                mappingReady: z.boolean(),
                externalInventoryItemId: z.string().nullable(),
                externalSku: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    blockers: z.array(publicationMembershipBlockerSchema),
    ready: z.boolean(),
  })
  .strict();
export const publicationMembershipReviewSchema = z
  .object({
    publicationTargetId: id,
    targetRevision: revision,
    authorityRevision: revision,
    reviewHash: hash,
    ready: z.boolean(),
    blockers: z.array(publicationMembershipBlockerSchema),
    changes: z.array(
      z
        .object({
          productVariantId: id,
          before: z.boolean(),
          after: z.boolean(),
        })
        .strict(),
    ),
    affectedProductIds: z.array(id).max(1000),
    quantities: z.array(
      z
        .object({
          productVariantId: id,
          desiredQuantity: z.string().regex(/^(0|[1-9][0-9]*)$/),
        })
        .strict(),
    ),
  })
  .strict();
export const publicationMembershipReceiptSchema = z
  .object({
    publicationTargetId: id,
    revision,
    reviewHash: hash,
    changedProductVariantIds: z.array(id),
    publicationRows: z.number().int().nonnegative(),
    appliedAt: z.string().datetime(),
    appliedBy: z.string().min(1),
    alreadyApplied: z.boolean(),
  })
  .strict();

export type InspectPublicationMembership = z.infer<
  typeof inspectPublicationMembershipSchema
>;
export type PublicationMembershipInspection = z.infer<
  typeof publicationMembershipInspectionSchema
>;
export type ReviewPublicationMembership = z.infer<
  typeof reviewPublicationMembershipSchema
>;
export type ApplyPublicationMembership = z.infer<
  typeof applyPublicationMembershipSchema
>;
export type PublicationMembershipReview = z.infer<
  typeof publicationMembershipReviewSchema
>;
export type PublicationMembershipReceipt = z.infer<
  typeof publicationMembershipReceiptSchema
>;
export type PublicationMembershipBlocker = z.infer<
  typeof publicationMembershipBlockerSchema
>;
