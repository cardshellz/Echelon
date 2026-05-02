import type { Express, Request, Response } from "express";
import type { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipStoreConnectionService } from "../../application/dropship-store-connection-service";
import { updateDropshipStoreOrderProcessingConfigInputSchema } from "../../application/dropship-store-connection-dtos";
import { DropshipError } from "../../domain/errors";
import { createDropshipStoreConnectionServiceFromEnv } from "../../infrastructure/dropship-store-connection.factory";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminStoreConnectionRoutes(
  app: Express,
  service: DropshipStoreConnectionService = createDropshipStoreConnectionServiceFromEnv(),
): void {
  app.put(
    "/api/dropship/admin/store-connections/:storeConnectionId/order-processing-config",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const storeConnectionId = parsePositiveInteger(req.params.storeConnectionId, "storeConnectionId");
        const input = parseBody(updateDropshipStoreOrderProcessingConfigInputSchema, req.body);
        const connection = await service.updateOrderProcessingConfig({
          storeConnectionId,
          defaultWarehouseId: input.defaultWarehouseId,
          idempotencyKey: input.idempotencyKey,
          actor: {
            actorType: "admin",
            actorId: sessionUser(req)?.id,
          },
        });
        return res.json({ connection });
      } catch (error) {
        return sendDropshipAdminStoreConnectionError(res, error);
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_INVALID_STORE_CONNECTION_REQUEST",
      "Dropship store connection request failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function sendDropshipAdminStoreConnectionError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipAdminStoreConnectionError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminStoreConnectionRoutes] Unexpected store connection error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_STORE_CONNECTION_INTERNAL_ERROR",
      message: "Dropship store connection request failed.",
    },
  });
}

function statusForDropshipAdminStoreConnectionError(code: string): number {
  switch (code) {
    case "DROPSHIP_INVALID_STORE_CONNECTION_REQUEST":
    case "DROPSHIP_STORE_ORDER_PROCESSING_WAREHOUSE_INVALID":
      return 400;
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}

function sessionUser(req: Request): SessionUser | null {
  const candidate = req.session.user as SessionUser | undefined;
  return candidate?.id ? candidate : null;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_INVALID_STORE_CONNECTION_REQUEST", "Route parameter must be a positive integer.", {
      key,
      value,
    });
  }
  return parsed;
}
