/** Authenticated operator endpoint for testing active US shipping rates. */

import type { Express } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import {
  ManualRateQuoteError,
  runManualRateQuote,
} from "../../application/manual-rate-quote.service";

export interface ManualRateQuoteRouteDependencies {
  runManualRateQuote: typeof runManualRateQuote;
}

const DEFAULT_DEPENDENCIES: ManualRateQuoteRouteDependencies = {
  runManualRateQuote,
};

export const manualRateQuoteRequestSchema = z.object({
  expectedRateBookId: z.number().int().positive(),
  pricingChannel: z.enum(["shopify", "internal", "ebay", "dropship"]),
  ratePurpose: z.enum(["customer_checkout", "vendor_fulfillment_charge"]),
  originWarehouseId: z.number().int().positive(),
  destination: z.object({
    country: z.string().trim().length(2),
    region: z.string().trim().min(2).max(100),
    postalCode: z.string().trim().min(5).max(10),
  }).strict(),
  billableWeightGrams: z.number().int().positive(),
}).strict();

const manualRateQuoteResponseSchema = z.object({
  outcome: z.enum(["quoted", "no_rate", "rate_book_mismatch"]),
  testedAt: z.string().datetime(),
  rateOwner: z.literal("echelon"),
  destination: z.object({
    country: z.string().length(2),
    region: z.string().length(2),
    postalCode: z.string().length(5),
  }),
  rateBook: z.object({ id: z.number().int().positive(), code: z.string() }).nullable(),
  zone: z.string().nullable(),
  quotes: z.array(z.object({
    serviceLevelId: z.number().int().positive(),
    serviceLevelCode: z.string(),
    displayName: z.string(),
    description: z.string().nullable(),
    fulfillmentMode: z.enum(["parcel", "freight"]),
    pricingBasis: z.enum(["shipment_weight", "pallet_count"]),
    totalCents: z.number().int().min(0),
    currency: z.string().length(3),
    promiseMinBusinessDays: z.number().int().min(0).nullable(),
    promiseMaxBusinessDays: z.number().int().min(0).nullable(),
    ratedMeasure: z.number().int().min(0),
    maxShipmentWeightGrams: z.number().int().positive().nullable(),
    chargeModel: z.enum(["fixed_band", "base_plus_per_started_pound"]),
    perStartedPoundCents: z.number().int().min(0).nullable(),
    billablePounds: z.number().int().min(0).nullable(),
    rateTableId: z.number().int().positive(),
    productPolicyApplied: z.boolean(),
    calculationTrace: z.array(z.object({
      kind: z.enum(["restriction", "base_charge", "threshold", "adjustment", "default"]),
      ruleId: z.number().int().positive().nullable(),
      label: z.string(),
      amountCents: z.number().int().min(0),
      skus: z.array(z.string()),
    })),
  })),
  warnings: z.array(z.string()),
});

export function registerManualRateQuoteRoutes(
  app: Express,
  dependencies: ManualRateQuoteRouteDependencies = DEFAULT_DEPENDENCIES,
): void {
  app.post(
    "/api/shipping/admin/rate-quotes/test",
    requirePermission("settings", "edit"),
    async (req, res) => {
      const parsed = manualRateQuoteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "SHIPPING_RATE_TEST_INPUT_INVALID",
            message: "The rate-test request is invalid.",
            issues: parsed.error.issues,
          },
        });
      }

      try {
        const result = await dependencies.runManualRateQuote({
          expectedRateBookId: parsed.data.expectedRateBookId,
          pricingChannel: parsed.data.pricingChannel,
          ratePurpose: parsed.data.ratePurpose,
          originWarehouseId: parsed.data.originWarehouseId,
          destinationCountry: parsed.data.destination.country,
          destinationRegion: parsed.data.destination.region,
          destinationPostalCode: parsed.data.destination.postalCode,
          billableWeightGrams: parsed.data.billableWeightGrams,
        });
        return res.json(manualRateQuoteResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ManualRateQuoteError) {
          return res.status(400).json({
            error: {
              code: error.code,
              message: error.message,
              context: error.context,
            },
          });
        }
        console.error(JSON.stringify({
          code: "SHIPPING_RATE_TEST_FAILED",
          message: "Manual shipping-rate test failed.",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return res.status(500).json({
          error: {
            code: "SHIPPING_RATE_TEST_FAILED",
            message: "The shipping-rate test could not be completed.",
          },
        });
      }
    },
  );
}
