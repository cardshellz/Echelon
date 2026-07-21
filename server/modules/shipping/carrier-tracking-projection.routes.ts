import type { Express, Request } from "express";
import { z } from "zod";

import { requireInternalApiKey } from "../../routes/middleware";
import type {
  CarrierTrackingProjectionCursor,
  CarrierTrackingProjectionReader,
} from "./carrier-tracking-projection.repository";

export const CARRIER_TRACKING_PROJECTION_PATH = "/api/internal/carrier-tracking/packages";

const isoDateString = z.string().datetime({ offset: true });
const querySchema = z.object({
  changedSince: isoDateString.optional(),
  observedThrough: isoDateString.optional(),
  afterChangedAt: isoDateString.optional(),
  afterProviderLabelId: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
}).superRefine((value, context) => {
  if (Boolean(value.afterChangedAt) !== Boolean(value.afterProviderLabelId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "afterChangedAt and afterProviderLabelId must be provided together",
    });
  }
});

export interface RegisterCarrierTrackingProjectionRoutesInput {
  reader: CarrierTrackingProjectionReader;
  now?: () => Date;
}

function toCursor(query: z.infer<typeof querySchema>): CarrierTrackingProjectionCursor | null {
  if (!query.afterChangedAt || !query.afterProviderLabelId) return null;
  return {
    stateChangedAt: new Date(query.afterChangedAt),
    providerLabelId: query.afterProviderLabelId,
  };
}

function requestPath(request: Request): string {
  return `${request.method} ${request.path}`;
}

export function registerCarrierTrackingProjectionRoutes(
  app: Express,
  input: RegisterCarrierTrackingProjectionRoutesInput,
): void {
  const now = input.now ?? (() => new Date());

  app.get(CARRIER_TRACKING_PROJECTION_PATH, requireInternalApiKey, async (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return response.status(400).json({
        error: "Invalid carrier tracking projection query",
        issues: parsed.error.issues,
      });
    }

    const observedThrough = parsed.data.observedThrough
      ? new Date(parsed.data.observedThrough)
      : now();
    const changedSince = parsed.data.changedSince
      ? new Date(parsed.data.changedSince)
      : null;
    if (changedSince && changedSince > observedThrough) {
      return response.status(400).json({
        error: "changedSince must not be later than observedThrough",
      });
    }

    try {
      const result = await input.reader.listChangedPackages({
        changedSince,
        observedThrough,
        after: toCursor(parsed.data),
        limit: parsed.data.limit,
      });
      return response.json({
        packages: result.packages.map((item) => ({
          ...item,
          eventOccurredAt: item.eventOccurredAt?.toISOString() ?? null,
          estimatedDeliveryAt: item.estimatedDeliveryAt?.toISOString() ?? null,
          actualDeliveryAt: item.actualDeliveryAt?.toISOString() ?? null,
          stateChangedAt: item.stateChangedAt.toISOString(),
        })),
        page: {
          observedThrough: observedThrough.toISOString(),
          hasMore: result.hasMore,
          nextCursor: result.nextCursor
            ? {
              stateChangedAt: result.nextCursor.stateChangedAt.toISOString(),
              providerLabelId: result.nextCursor.providerLabelId,
            }
            : null,
        },
      });
    } catch (error) {
      console.error("[CarrierTrackingProjection] Read failed", {
        path: requestPath(request),
        error: error instanceof Error ? error.message : String(error),
      });
      return response.status(500).json({ error: "Failed to read carrier tracking projection" });
    }
  });
}
