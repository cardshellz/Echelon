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

// Staff-only calculation evidence. Returned only when the caller holds the
// Dropship operations permission; vendors never receive these fields (the
// public contract stays the final charge and scenario). Weights are grams and
// may be fractional (catalog numeric(10,2)); every money field is integer cents.
const gramsSchema = z.number().finite().nonnegative();
const millimetresSchema = z.number().finite().nonnegative();
const calculationItemSchema = z.object({
  productVariantId: idSchema,
  sku: z.string().nullable(),
  quantity: z.number().int().positive().max(MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY),
  unitWeightGrams: gramsSchema.nullable(),
  lineWeightGrams: gramsSchema.nullable(),
}).strict();
const calculationPackageSchema = z.object({
  packageSequence: z.number().int().positive(),
  boxCode: z.string().nullable(),
  weightGrams: gramsSchema,
  lengthMm: millimetresSchema.nullable(),
  widthMm: millimetresSchema.nullable(),
  heightMm: millimetresSchema.nullable(),
  items: z.array(z.object({ productVariantId: idSchema, quantity: z.number().int().positive() }).strict()),
}).strict();
const policyStepSchema = z.object({
  kind: z.enum(["restriction", "base_charge", "threshold", "adjustment", "default"]),
  ruleId: idSchema.nullable(),
  label: z.string(),
  amountCents: z.number().int().safe(),
  skus: z.array(z.string()),
}).strict();
const sharedEngineRateSchema = z.object({
  source: z.literal("shared_engine"),
  rateBookId: idSchema,
  rateBookCode: z.string(),
  rateTableId: idSchema,
  rateRowId: idSchema.nullable(),
  serviceLevelCode: z.string(),
  serviceLevelName: z.string(),
  zone: z.string().nullable(),
  ratedWeightGrams: gramsSchema,
  chargeModel: z.string(),
  rowMaxShipmentWeightGrams: gramsSchema.nullable(),
  perStartedPoundCents: centsSchema.nullable(),
  billablePounds: z.number().int().nonnegative().nullable(),
  productPolicyApplied: z.boolean(),
  policySteps: z.array(policyStepSchema),
}).strict();
const legacyRateSchema = z.object({
  source: z.literal("legacy_rate_table"),
  zone: z.string(),
  zoneRuleId: idSchema,
  packages: z.array(z.object({
    packageSequence: z.number().int().positive(),
    rateTableId: idSchema,
    carrier: z.string(),
    service: z.string(),
    rateCents: centsSchema,
  }).strict()),
}).strict();
export const listingShippingEstimateCalculationSchema = z.object({
  pricingSource: z.enum(["shared", "legacy"]),
  cutoverMode: z.enum(["legacy", "test", "live"]),
  cutoverReasonCode: z.string(),
  originWarehouseId: idSchema,
  items: z.array(calculationItemSchema).min(1),
  packages: z.array(calculationPackageSchema),
  rate: z.discriminatedUnion("source", [sharedEngineRateSchema, legacyRateSchema]),
  charges: z.object({
    baseCents: centsSchema,
    markupCents: centsSchema,
    insuranceCents: centsSchema,
    dunnageCents: centsSchema,
    totalCents: centsSchema,
  }).strict(),
  warnings: z.array(z.string()),
}).strict();
export type ListingShippingEstimateCalculation = z.infer<typeof listingShippingEstimateCalculationSchema>;

export const listingShippingEstimateResultSchema = z.discriminatedUnion("status", [
  scenarioSchema.extend({
    status: z.literal("estimated"),
    totalShippingCents: centsSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    calculation: listingShippingEstimateCalculationSchema.optional(),
  }).strict(),
  scenarioSchema.extend({ status: z.literal("unavailable"), code: z.literal(LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE),
    message: z.literal(LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE) }).strict(),
]);

export const listingShippingEstimateResponseSchema = z.object({ estimate: listingShippingEstimateResultSchema }).strict();
export type ListingShippingEstimateInput = z.infer<typeof listingShippingEstimateInputSchema>;
export type ListingShippingEstimateResult = z.infer<typeof listingShippingEstimateResultSchema>;
