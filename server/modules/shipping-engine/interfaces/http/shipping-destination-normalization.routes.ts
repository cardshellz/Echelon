import type { Express } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../../../../routes/middleware";
import { ShippingDestinationNormalizationService } from "../../application/shipping-destination-normalization.service";
import type {
  ShippingDestinationInput,
  ShippingDestinationNormalizationResult,
} from "../../domain/shipping-destination-normalization";

const requestSchema = z.object({
  country: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100).nullable().optional(),
  postalCode: z.string().trim().min(1).max(32).nullable().optional(),
}).strict();

const successResponseSchema = z.object({
  destination: z.object({
    country: z.literal("US"),
    region: z.string().length(2).nullable(),
    postalCode: z.string().min(1).max(32).nullable(),
  }).strict(),
}).strict();

export interface ShippingDestinationNormalizationRouteDependencies {
  normalize: (
    input: ShippingDestinationInput,
  ) => ShippingDestinationNormalizationResult;
}

const normalizationService = new ShippingDestinationNormalizationService();

const DEFAULT_DEPENDENCIES: ShippingDestinationNormalizationRouteDependencies = {
  normalize: (input) => normalizationService.normalize(input),
};

export function registerShippingDestinationNormalizationRoutes(
  app: Express,
  dependencies: ShippingDestinationNormalizationRouteDependencies = DEFAULT_DEPENDENCIES,
): void {
  app.post(
    "/api/shipping/internal/destinations/normalize",
    requireInternalApiKey,
    (req, res) => {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "SHIPPING_DESTINATION_NORMALIZATION_INPUT_INVALID",
            message: "The shipping destination normalization input is invalid.",
          },
        });
      }

      try {
        const result = dependencies.normalize(parsed.data);
        if (!result.ok) {
          return res.status(422).json({
            error: {
              code: result.code,
              message: result.message,
            },
          });
        }

        return res.json(successResponseSchema.parse({
          destination: result.destination,
        }));
      } catch (error) {
        console.error(JSON.stringify({
          code: "SHIPPING_DESTINATION_NORMALIZATION_FAILED",
          message: "The shipping destination could not be normalized.",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return res.status(500).json({
          error: {
            code: "SHIPPING_DESTINATION_NORMALIZATION_FAILED",
            message: "The shipping destination could not be normalized.",
          },
        });
      }
    },
  );
}
