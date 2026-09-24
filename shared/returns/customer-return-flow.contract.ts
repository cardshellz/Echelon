import { z } from "zod";
import {
  MAX_RETURN_ORIGINAL_BOXES, customerReturnBoxOptionSchema, customerReturnDimensionsSchema,
  customerReturnParcelWeightSchema, customerReturnUnitWeightSchema,
} from "./customer-return-parcel";

// Bounds for this read-only flow. Live label-service parcel limits remain a
// separate shipping policy and cannot be inferred from this UI payload bound.
export const MAX_RETURN_FLOW_PARCELS = 20;
export const MAX_RETURN_FLOW_LINES = 200;
const quantity = z.number().int().nonnegative().safe();
const positiveQuantity = quantity.refine(
  (value) => value > 0,
  "Choose at least one item.",
);
const lineId = z.string().min(1).max(255);

export const customerReturnSourceRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export const customerReturnFlowReasonSchema = z.enum([
  "no_longer_needed",
  "ordered_by_mistake",
  "wrong_item",
  "damaged",
  "other",
]);
export type CustomerReturnFlowReason = z.infer<
  typeof customerReturnFlowReasonSchema
>;

export const customerReturnFlowOrderSchema = z
  .object({
    sourceRevision: customerReturnSourceRevisionSchema,
    orderReference: z.string().min(1).max(50),
    purchasedAt: z.string().datetime(),
    evaluatedAt: z.string().datetime(),
    returnWindowEndsAt: z.string().datetime(),
    message: z.string().max(500).nullable(),
    boxOptions: z.array(customerReturnBoxOptionSchema).max(MAX_RETURN_ORIGINAL_BOXES),
    lines: z
      .array(
        z
          .object({
            id: lineId,
            title: z.string().min(1).max(1000),
            variant: z.string().max(1000).nullable(),
            sku: z.string().max(255).nullable(),
            unitWeightGrams: customerReturnUnitWeightSchema,
            purchasedQuantity: quantity,
            deliveredQuantity: quantity,
            // Unknown history must not be represented as zero available claims.
            alreadyReturningQuantity: quantity.nullable(),
            eligibleQuantity: quantity,
            message: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(MAX_RETURN_FLOW_LINES),
  })
  .strict();
export type CustomerReturnFlowOrder = z.infer<
  typeof customerReturnFlowOrderSchema
>;

export const customerReturnFlowReviewInputSchema = z
  .object({
    sourceRevision: customerReturnSourceRevisionSchema,
    orderReference: z.string().min(1).max(256),
    selections: z
      .array(
        z
          .object({
            lineId,
            quantity: positiveQuantity,
            reasonCode: customerReturnFlowReasonSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_FLOW_LINES),
    parcels: z
      .array(
        z
          .object({
            dimensions: customerReturnDimensionsSchema,
            originalBoxId: z.string().min(1).max(255).nullable(),
            items: z
              .array(z.object({ lineId, quantity: positiveQuantity }).strict())
              .min(1)
              .max(MAX_RETURN_FLOW_LINES),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_FLOW_PARCELS),
  })
  .strict();
export type CustomerReturnFlowReviewInput = z.infer<
  typeof customerReturnFlowReviewInputSchema
>;

export const customerReturnFlowReviewSchema = z
  .object({
    sourceRevision: customerReturnSourceRevisionSchema,
    effects: z.literal("none"),
    orderReference: z.string().min(1).max(50),
    selectedQuantity: positiveQuantity,
    parcels: z
      .array(
        z
          .object({
            number: z.number().int().positive().max(MAX_RETURN_FLOW_PARCELS),
            dimensions: customerReturnDimensionsSchema,
            weightGrams: customerReturnParcelWeightSchema,
            items: z
              .array(
                z
                  .object({
                    lineId,
                    title: z.string().min(1).max(1000),
                    quantity: positiveQuantity,
                  })
                  .strict(),
              )
              .min(1)
              .max(MAX_RETURN_FLOW_LINES),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_FLOW_PARCELS),
    refundMethod: z.literal("manual_shopify"),
  })
  .strict();
export type CustomerReturnFlowReview = z.infer<
  typeof customerReturnFlowReviewSchema
>;
