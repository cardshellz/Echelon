import { z } from "zod";
import {
  MAX_RETURN_ORIGINAL_BOXES, customerReturnBoxOptionSchema, customerReturnDimensionsSchema,
  customerReturnParcelWeightSchema, customerReturnUnitWeightSchema,
} from "./customer-return-parcel";

// Preview payload bounds, not a live shipping policy. Live parcel limits must
// come from the configured shipping service when that adapter is connected.
export const MAX_PREVIEW_PARCELS = 20;
export const MAX_PREVIEW_LINES = 200;
const quantity = z.number().int().nonnegative().safe();
const positiveQuantity = quantity.refine((value) => value > 0, "Choose at least one item.");
const lineId = z.string().min(1).max(255);

export const returnPreviewScenarioIdSchema = z.enum([
  "split_delivered", "partially_delivered", "in_transit", "already_returning", "outside_window",
]);
export type ReturnPreviewScenarioId = z.infer<typeof returnPreviewScenarioIdSchema>;

export const returnPreviewReasonSchema = z.enum([
  "no_longer_needed", "ordered_by_mistake", "wrong_item", "damaged", "other",
]);
export type ReturnPreviewReason = z.infer<typeof returnPreviewReasonSchema>;

export const returnPortalPreviewStateSchema = z.object({
  mode: z.literal("admin_preview"),
  customerAccess: z.literal("disabled"),
  dataSource: z.literal("sample_orders"),
  scenarios: z.array(z.object({
    id: returnPreviewScenarioIdSchema,
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    orderReference: z.string().min(1).max(50),
  }).strict()).min(1).max(20),
}).strict();
export type ReturnPortalPreviewState = z.infer<typeof returnPortalPreviewStateSchema>;

export const returnPreviewLookupInputSchema = z.object({
  scenarioId: returnPreviewScenarioIdSchema,
  orderReference: z.string().min(1).max(256),
}).strict();
export type ReturnPreviewLookupInput = z.infer<typeof returnPreviewLookupInputSchema>;

export const returnPreviewOrderSchema = z.object({
  mode: z.literal("admin_preview"),
  scenarioId: returnPreviewScenarioIdSchema,
  orderReference: z.string().min(1).max(50),
  purchasedAt: z.string().datetime(),
  evaluatedAt: z.string().datetime(),
  returnWindowEndsAt: z.string().datetime(),
  message: z.string().max(500).nullable(),
  boxOptions: z.array(customerReturnBoxOptionSchema).max(MAX_RETURN_ORIGINAL_BOXES),
  lines: z.array(z.object({
    id: lineId,
    title: z.string().min(1).max(255),
    variant: z.string().max(255).nullable(),
    sku: z.string().max(255).nullable(),
    unitWeightGrams: customerReturnUnitWeightSchema,
    purchasedQuantity: quantity,
    deliveredQuantity: quantity,
    alreadyReturningQuantity: quantity,
    eligibleQuantity: quantity,
    message: z.string().max(500).nullable(),
  }).strict()).max(MAX_PREVIEW_LINES),
}).strict();
export type ReturnPreviewOrder = z.infer<typeof returnPreviewOrderSchema>;

export const returnPreviewReviewInputSchema = returnPreviewLookupInputSchema.extend({
  selections: z.array(z.object({
    lineId,
    quantity: positiveQuantity,
    reasonCode: returnPreviewReasonSchema.nullable(),
  }).strict()).min(1).max(MAX_PREVIEW_LINES),
  parcels: z.array(z.object({
    dimensions: customerReturnDimensionsSchema,
    originalBoxId: z.string().min(1).max(255).nullable(),
    items: z.array(z.object({ lineId, quantity: positiveQuantity }).strict())
      .min(1).max(MAX_PREVIEW_LINES),
  }).strict()).min(1).max(MAX_PREVIEW_PARCELS),
}).strict();
export type ReturnPreviewReviewInput = z.infer<typeof returnPreviewReviewInputSchema>;

export const returnPreviewReviewSchema = z.object({
  mode: z.literal("admin_preview"),
  effects: z.literal("none"),
  orderReference: z.string().min(1).max(50),
  selectedQuantity: positiveQuantity,
  parcels: z.array(z.object({
    number: z.number().int().positive().max(MAX_PREVIEW_PARCELS),
    dimensions: customerReturnDimensionsSchema,
    weightGrams: customerReturnParcelWeightSchema,
    items: z.array(z.object({
      lineId,
      title: z.string().min(1).max(255),
      quantity: positiveQuantity,
    }).strict()).min(1).max(MAX_PREVIEW_LINES),
  }).strict()).min(1).max(MAX_PREVIEW_PARCELS),
  refundMethod: z.literal("manual_shopify"),
}).strict();
export type ReturnPreviewReview = z.infer<typeof returnPreviewReviewSchema>;
