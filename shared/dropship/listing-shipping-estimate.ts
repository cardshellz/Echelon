import { z } from "zod";

// Bounds estimator/cartonization work; this is not an order quantity limit.
// Quantity counts sellable variants (packs), never the eaches inside a pack.
export const MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY = 1000;
const idSchema = z.number().int().positive().safe();
const centsSchema = z.number().int().nonnegative().safe();
const destinationInputSchema = z.object({
  country: z.string().trim().regex(/^[A-Za-z]{2}$/),
  region: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(20),
}).strict();

export const listingShippingEstimateInputSchema = z.object({
  storeConnectionId: idSchema,
  productVariantId: idSchema,
  quantity: z.number().int().positive().max(MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY),
  destination: destinationInputSchema,
}).strict();

const scenarioSchema = z.object({
  storeConnectionId: idSchema,
  productVariantId: idSchema,
  quantity: z.number().int().positive().max(MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY),
  destination: z.object({ country: z.string().regex(/^[A-Z]{2}$/), region: z.string().nullable(), postalCode: z.string().min(1) }).strict(),
  estimatedAt: z.string().datetime(),
  warnings: z.array(z.string()),
});

export const listingShippingEstimateResultSchema = z.discriminatedUnion("status", [
  scenarioSchema.extend({
    status: z.literal("estimated"),
    warehouseId: idSchema,
    packageCount: z.number().int().positive().safe(),
    totalShippingCents: centsSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    breakdown: z.object({ baseRateCents: centsSchema, markupCents: centsSchema, insurancePoolCents: centsSchema, dunnageCents: centsSchema }).strict(),
    rate: z.object({
      source: z.enum(["legacy", "shared"]),
      rateTableIds: z.array(idSchema).min(1),
      rateBookId: idSchema.nullable(),
      serviceLevelCode: z.string().nullable(),
      displayName: z.string().nullable(),
    }).strict(),
  }).strict(),
  scenarioSchema.extend({ status: z.literal("unavailable"), code: z.string().min(1), message: z.string().min(1) }).strict(),
]);

export const listingShippingEstimateResponseSchema = z.object({ estimate: listingShippingEstimateResultSchema }).strict();
export type ListingShippingEstimateInput = z.infer<typeof listingShippingEstimateInputSchema>;
export type ListingShippingEstimateResult = z.infer<typeof listingShippingEstimateResultSchema>;
