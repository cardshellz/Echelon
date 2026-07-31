import type { Express } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../../../../routes/middleware";
import {
  computeCheckoutRatePreview,
  type CheckoutRatePreviewResult,
} from "./carrier-callback.routes";

const previewLineSchema = z.object({
  sku: z.string().trim().min(1).max(255).nullable(),
  quantity: z.number().int().min(1).max(10_000),
  grams: z.number().int().min(1).max(1_000_000_000).nullable(),
  priceCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict().superRefine((line, context) => {
  if (line.sku === null && line.grams === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sku"],
      message: "A line without a SKU must include a positive unit weight.",
    });
  }
});

const previewGroupSchema = z.object({
  code: z.string().trim().min(1).max(100).nullable(),
  lines: z.array(previewLineSchema).min(1).max(100),
}).strict();

export const storefrontRatePreviewRequestSchema = z.object({
  destination: z.object({
    country: z.string().trim().min(2).max(3),
    region: z.string().trim().min(1).max(100).nullable(),
    postalCode: z.string().trim().min(1).max(20),
  }).strict(),
  groups: z.array(previewGroupSchema).min(1).max(10),
}).strict();

const storefrontRatePreviewResponseSchema = z.object({
  groups: z.array(z.object({
    code: z.string().nullable(),
    disposition: z.string(),
    rates: z.array(z.object({
      serviceCode: z.string().min(1),
      displayName: z.string().min(1),
      totalCents: z.number().int().min(0),
      currency: z.string().length(3),
      description: z.string().optional(),
    })),
  })),
});

export interface StorefrontRatePreviewRouteDependencies {
  computeCheckoutRatePreview: (body: unknown) => Promise<CheckoutRatePreviewResult>;
}

const DEFAULT_DEPENDENCIES: StorefrontRatePreviewRouteDependencies = {
  computeCheckoutRatePreview,
};

export function registerStorefrontRatePreviewRoutes(
  app: Express,
  dependencies: StorefrontRatePreviewRouteDependencies = DEFAULT_DEPENDENCIES,
): void {
  app.post(
    "/api/shipping/internal/storefront-rate-preview",
    requireInternalApiKey,
    async (req, res) => {
      const parsed = storefrontRatePreviewRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: {
            code: "STOREFRONT_RATE_PREVIEW_INPUT_INVALID",
            message: "The storefront rate-preview request is invalid.",
            issues: parsed.error.issues,
          },
        });
      }

      try {
        const groups = await Promise.all(parsed.data.groups.map(async (group) => {
          const result = await dependencies.computeCheckoutRatePreview({
            rate: {
              destination: {
                postal_code: parsed.data.destination.postalCode,
                country: parsed.data.destination.country,
                province_code: parsed.data.destination.region,
              },
              items: group.lines.map((line) => ({
                sku: line.sku,
                quantity: line.quantity,
                grams: line.grams,
                price: line.priceCents,
              })),
            },
          });

          return {
            code: group.code,
            disposition: result.disposition,
            rates: result.rates.map((rate) => ({
              serviceCode: rate.service_code,
              displayName: rate.service_name,
              totalCents: Number(rate.total_price),
              currency: rate.currency,
              ...(rate.description ? { description: rate.description } : {}),
            })),
          };
        }));

        return res.json(storefrontRatePreviewResponseSchema.parse({ groups }));
      } catch (error) {
        console.error(JSON.stringify({
          code: "STOREFRONT_RATE_PREVIEW_FAILED",
          message: "Storefront shipping-rate preview failed.",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return res.status(500).json({
          error: {
            code: "STOREFRONT_RATE_PREVIEW_FAILED",
            message: "The storefront shipping-rate preview could not be completed.",
          },
        });
      }
    },
  );
}
