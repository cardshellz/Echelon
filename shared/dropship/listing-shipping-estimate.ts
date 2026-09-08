import { z } from "zod";

// Bounds estimator/cartonization work; this is not an order quantity limit.
// Quantity counts sellable variants (packs), never the eaches inside a pack.
export const MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY = 1000;
// Customer-facing messages are allowlisted. Provider diagnostics, fee policies,
// and pricing-program details belong in server logs, never this public DTO.
export const LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE = "DROPSHIP_LISTING_SHIPPING_ESTIMATE_UNAVAILABLE";
export const LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE = "We couldn't estimate shipping for this quantity and destination. Please contact support.";
export const LISTING_SHIPPING_ESTIMATE_WARNING = "This estimate uses the available fulfillment details; final shipping is confirmed during order processing.";
const idSchema = z.number().int().positive().safe();
const centsSchema = z.number().int().nonnegative().safe();
const destinationInputSchema = z.object({
  country: z.string().trim().regex(/^[A-Za-z]{2}$/),
  region: z.string().trim().regex(/^[A-Za-z]{2}$/, "Enter a two-letter state or region code."),
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
  warnings: z.array(z.literal(LISTING_SHIPPING_ESTIMATE_WARNING)).max(1),
});

export const listingShippingEstimateResultSchema = z.discriminatedUnion("status", [
  scenarioSchema.extend({
    status: z.literal("estimated"),
    totalShippingCents: centsSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  scenarioSchema.extend({ status: z.literal("unavailable"), code: z.literal(LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE),
    message: z.literal(LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE) }).strict(),
]);

export const listingShippingEstimateResponseSchema = z.object({ estimate: listingShippingEstimateResultSchema }).strict();
export type ListingShippingEstimateInput = z.infer<typeof listingShippingEstimateInputSchema>;
export type ListingShippingEstimateResult = z.infer<typeof listingShippingEstimateResultSchema>;
