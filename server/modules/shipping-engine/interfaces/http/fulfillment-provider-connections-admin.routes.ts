import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import {
  FulfillmentProviderConnectionError,
  FulfillmentProviderConnectionService,
} from "../../application/fulfillment-provider-connections.service";
import { AesGcmFulfillmentProviderCredentialCipher } from "../../infrastructure/fulfillment-provider-credential-cipher";
import { PostgresFulfillmentProviderConnectionStore } from "../../infrastructure/fulfillment-provider-connections.repository";
import { createFulfillmentProviderRegistry } from "../../infrastructure/fulfillment-provider-registry";

const idSchema = z.coerce.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(16).max(200);
const createSchema = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/),
  name: z.string().trim().min(1).max(160),
  credential: z.string().trim().min(1).max(4_096),
  idempotencyKey: idempotencyKeySchema,
}).strict();
const credentialSchema = z.object({
  credential: z.string().trim().min(1).max(4_096),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();
const stateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

type ConnectionService = Pick<
  FulfillmentProviderConnectionService,
  "getAdminView" | "createConnection" | "replaceCredential" | "verifyConnection" | "setConnectionEnabled"
>;

export interface FulfillmentProviderConnectionAdminRouteDependencies {
  service?: ConnectionService;
}

export function registerFulfillmentProviderConnectionAdminRoutes(
  app: Express,
  dependencies: FulfillmentProviderConnectionAdminRouteDependencies = {},
): void {
  const service = dependencies.service ?? defaultService();

  app.get(
    "/api/shipping/admin/fulfillment-provider-connections",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        return res.json(await service.getAdminView());
      } catch (error) {
        return sendConnectionError(res, error, "load fulfillment provider connections", auditActorOrNull(_req));
      }
    },
  );

  app.post(
    "/api/shipping/admin/fulfillment-provider-connections",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const command = parseBody(createSchema, req.body);
        const result = await service.createConnection({ command, actorUserId: auditActor(req) });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendConnectionError(res, error, "create fulfillment provider connection", auditActorOrNull(req));
      }
    },
  );

  app.put(
    "/api/shipping/admin/fulfillment-provider-connections/:connectionId/credential",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        return res.json(await service.replaceCredential({
          connectionId: parseId(req.params.connectionId),
          command: parseBody(credentialSchema, req.body),
          actorUserId: auditActor(req),
        }));
      } catch (error) {
        return sendConnectionError(res, error, "replace fulfillment provider credential", auditActorOrNull(req));
      }
    },
  );

  app.post(
    "/api/shipping/admin/fulfillment-provider-connections/:connectionId/verify",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        return res.json(await service.verifyConnection({
          connectionId: parseId(req.params.connectionId),
          command: parseBody(stateSchema, req.body),
          actorUserId: auditActor(req),
        }));
      } catch (error) {
        return sendConnectionError(res, error, "verify fulfillment provider connection", auditActorOrNull(req));
      }
    },
  );

  for (const enabled of [true, false] as const) {
    app.post(
      `/api/shipping/admin/fulfillment-provider-connections/:connectionId/${enabled ? "enable" : "disable"}`,
      requirePermission("settings", "edit"),
      async (req, res) => {
        try {
          return res.json(await service.setConnectionEnabled({
            connectionId: parseId(req.params.connectionId),
            enabled,
            command: parseBody(stateSchema, req.body),
            actorUserId: auditActor(req),
          }));
        } catch (error) {
          return sendConnectionError(
            res,
            error,
            `${enabled ? "enable" : "disable"} fulfillment provider connection`,
            auditActorOrNull(req),
          );
        }
      },
    );
  }
}

function defaultService(): FulfillmentProviderConnectionService {
  const environment = process.env;
  return new FulfillmentProviderConnectionService({
    store: new PostgresFulfillmentProviderConnectionStore(),
    registry: createFulfillmentProviderRegistry(),
    credentialCipher: AesGcmFulfillmentProviderCredentialCipher.fromEnvOrNull(environment),
    environment,
  });
}

function parseId(value: string): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new FulfillmentProviderConnectionError(
      400,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_INVALID_ID",
      "Invalid fulfillment provider connection id.",
    );
  }
  return parsed.data;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new FulfillmentProviderConnectionError(
      400,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_INVALID_INPUT",
      "Review the fulfillment provider connection fields.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new FulfillmentProviderConnectionError(
      401,
      "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_ACTOR_REQUIRED",
      "An authenticated operator is required to change fulfillment provider connections.",
    );
  }
  return actor;
}

function sendConnectionError(
  res: Response,
  error: unknown,
  action: string,
  actorUserId: string | null,
): Response {
  if (error instanceof FulfillmentProviderConnectionError) {
    logRejectedCommand({ action, actorUserId, errorCode: error.code, status: error.status });
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (isPostgresError(error, "23505")) {
    logRejectedCommand({ action, actorUserId, errorCode: "POSTGRES_23505", status: 409 });
    return res.status(409).json({
      error: {
        code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_CONFLICT",
        message: "A provider connection with this name already exists or the command was already applied.",
      },
    });
  }
  if (isPostgresError(error, "23503") || isPostgresError(error, "23514")) {
    const postgresCode = postgresErrorCode(error);
    logRejectedCommand({ action, actorUserId, errorCode: `POSTGRES_${postgresCode}`, status: 400 });
    return res.status(400).json({
      error: {
        code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_REFERENCE_INVALID",
        message: "The provider connection request references invalid or inconsistent data.",
      },
    });
  }
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "shipping.fulfillment_provider_connection.admin_failed",
    action,
    actorUserId,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: postgresErrorCode(error),
  }));
  return res.status(500).json({
    error: {
      code: "SHIPPING_FULFILLMENT_PROVIDER_CONNECTION_INTERNAL_ERROR",
      message: `Failed to ${action}.`,
    },
  });
}

function logRejectedCommand(input: {
  action: string;
  actorUserId: string | null;
  errorCode: string;
  status: number;
}): void {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "warn",
    event: "shipping.fulfillment_provider_connection.command_rejected",
    ...input,
  }));
}

function auditActorOrNull(req: Request): string | null {
  return req.session?.user?.id ?? null;
}

function isPostgresError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
