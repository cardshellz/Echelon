import type { Express } from "express";
import { z } from "zod";
import type {
  ShippingDestinationScopeSummary,
} from "@shared/types/shipping-channel-routing";
import { requireInternalApiKey } from "../../../../routes/middleware";
import { DestinationScopeReadService } from "../../application/destination-scope-reader";
import { PostgresDestinationScopeReader } from "../../infrastructure/destination-scope-reader";

const destinationScopeResponseSchema = z.object({
  scopes: z.array(z.object({
    id: z.number().int().positive(),
    code: z.string().min(1),
    name: z.string().min(1),
    status: z.literal("active"),
    lockVersion: z.number().int().positive(),
    members: z.array(z.object({
      country: z.string().min(2).max(3),
      region: z.string().nullable(),
      postalPrefix: z.string().nullable(),
    }).strict()),
    updatedAt: z.string().datetime(),
  }).strict()),
}).strict();

export interface DestinationScopeReaderRouteDependencies {
  listActiveDestinationScopes: () => Promise<ShippingDestinationScopeSummary[]>;
}

const destinationScopeReadService = new DestinationScopeReadService(
  new PostgresDestinationScopeReader(),
);

const DEFAULT_DEPENDENCIES: DestinationScopeReaderRouteDependencies = {
  listActiveDestinationScopes: () => destinationScopeReadService.listActive(),
};

export function registerDestinationScopeReaderRoutes(
  app: Express,
  dependencies: DestinationScopeReaderRouteDependencies = DEFAULT_DEPENDENCIES,
): void {
  app.get(
    "/api/shipping/internal/destination-scopes",
    requireInternalApiKey,
    async (_req, res) => {
      try {
        const scopes = await dependencies.listActiveDestinationScopes();
        return res.json(destinationScopeResponseSchema.parse({ scopes }));
      } catch (error) {
        console.error(JSON.stringify({
          code: "DESTINATION_SCOPE_READ_FAILED",
          message: "Active shipping destination scopes could not be read.",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }));
        return res.status(500).json({
          error: {
            code: "DESTINATION_SCOPE_READ_FAILED",
            message: "Active shipping destination scopes could not be read.",
          },
        });
      }
    },
  );
}
