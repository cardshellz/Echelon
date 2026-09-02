import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import {
  ConnectedFulfillmentMethodCatalogService,
} from "../../application/connected-fulfillment-method-catalog.service";
import {
  FulfillmentRoutingError,
  FulfillmentRoutingService,
} from "../../application/fulfillment-routing.service";
import { PostgresFulfillmentRoutingStore } from "../../infrastructure/fulfillment-routing.repository";
import { AesGcmFulfillmentProviderCredentialCipher } from "../../infrastructure/fulfillment-provider-credential-cipher";
import { PostgresFulfillmentProviderConnectionStore } from "../../infrastructure/fulfillment-provider-connections.repository";
import { createFulfillmentProviderRegistry } from "../../infrastructure/fulfillment-provider-registry";

const idSchema = z.coerce.number().int().positive();
const replaceProfileSchema = z.object({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().trim().min(16).max(200),
  methods: z.array(z.object({
    providerConnectionId: z.number().int().positive(),
    provider: z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/),
    providerAccountId: z.string().trim().min(1).max(120),
    serviceCode: z.string().trim().min(1).max(80),
  }).strict()).max(200),
}).strict();

type RoutingService = Pick<
  FulfillmentRoutingService,
  "getAdminView" | "replaceProfile"
>;

export interface FulfillmentRoutingAdminRouteDependencies {
  service?: RoutingService;
}

export function registerFulfillmentRoutingAdminRoutes(
  app: Express,
  dependencies: FulfillmentRoutingAdminRouteDependencies = {},
): void {
  const service = dependencies.service ?? defaultService();

  app.get(
    "/api/shipping/admin/service-levels/:serviceLevelId/fulfillment-routing",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        return res.json(await service.getAdminView(parseId(req.params.serviceLevelId)));
      } catch (error) {
        return sendRoutingError(res, error, "load fulfillment routing");
      }
    },
  );

  app.put(
    "/api/shipping/admin/service-levels/:serviceLevelId/fulfillment-routing",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const command = parseBody(req.body);
        return res.json(await service.replaceProfile({
          serviceLevelId: parseId(req.params.serviceLevelId),
          command,
          actorUserId: auditActor(req),
        }));
      } catch (error) {
        return sendRoutingError(res, error, "replace fulfillment routing");
      }
    },
  );
}

function defaultService(): FulfillmentRoutingService {
  const environment = process.env;
  const connectionStore = new PostgresFulfillmentProviderConnectionStore();
  return new FulfillmentRoutingService({
    store: new PostgresFulfillmentRoutingStore(),
    catalogProvider: new ConnectedFulfillmentMethodCatalogService({
      store: connectionStore,
      registry: createFulfillmentProviderRegistry(),
      credentialCipher: AesGcmFulfillmentProviderCredentialCipher.fromEnvOrNull(environment),
      environment,
    }),
  });
}

function parseId(value: string): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new FulfillmentRoutingError(
      400,
      "SHIPPING_FULFILLMENT_ROUTING_INVALID_ID",
      "Invalid shipping service-level id.",
    );
  }
  return parsed.data;
}

function parseBody(body: unknown) {
  const parsed = replaceProfileSchema.safeParse(body);
  if (!parsed.success) {
    throw new FulfillmentRoutingError(
      400,
      "SHIPPING_FULFILLMENT_ROUTING_INVALID_INPUT",
      "Review the fulfillment routing fields.",
      parsed.error.issues.map((issue) => (
        `${issue.path.join(".") || "request"}: ${issue.message}`
      )),
    );
  }
  return parsed.data;
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new FulfillmentRoutingError(
      401,
      "SHIPPING_FULFILLMENT_ROUTING_ACTOR_REQUIRED",
      "An authenticated operator is required to change fulfillment routing.",
    );
  }
  return actor;
}

function sendRoutingError(
  res: Response,
  error: unknown,
  action: string,
): Response {
  if (error instanceof FulfillmentRoutingError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }
  if (isPostgresError(error, "23505")) {
    return res.status(409).json({
      error: {
        code: "SHIPPING_FULFILLMENT_ROUTING_CONFLICT",
        message: "The fulfillment routing profile changed. Refresh it before saving.",
      },
    });
  }
  if (isPostgresError(error, "23503") || isPostgresError(error, "23514")) {
    return res.status(400).json({
      error: {
        code: "SHIPPING_FULFILLMENT_ROUTING_REFERENCE_INVALID",
        message: "A referenced service level or provider method is no longer valid.",
      },
    });
  }
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "shipping.fulfillment_routing.admin_failed",
    action,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : "Unknown error",
  }));
  return res.status(500).json({
    error: {
      code: "SHIPPING_FULFILLMENT_ROUTING_INTERNAL_ERROR",
      message: `Failed to ${action}.`,
    },
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}
