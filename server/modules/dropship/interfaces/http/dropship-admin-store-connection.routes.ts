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
  app.get(
    "/api/dropship/admin/store-connections",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const result = await service.listForAdmin({
          statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
          platform: parseOptionalPlatformQuery(req.query.platform),
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          search: parseOptionalStringQuery(req.query.search),
          page: parseNumberQuery(req.query.page, 1),
          limit: parseNumberQuery(req.query.limit, 50),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipAdminStoreConnectionError(res, error);
      }
    },
  );

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
    case "DROPSHIP_STORE_CONNECTION_LIST_INVALID_INPUT":
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

function parseStatusesQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const statuses = value.flatMap((entry) => parseStatusesQuery(entry) ?? []);
    return statuses.length > 0 ? statuses : undefined;
  }
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  return parsed.split(",").map((status) => status.trim()).filter(Boolean);
}

function parseOptionalPlatformQuery(value: unknown): string | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed || parsed === "all") {
    return undefined;
  }
  return parsed;
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  const asNumber = Number(parsed);
  return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : undefined;
}

function parseNumberQuery(value: unknown, fallback: number): number {
  return parseOptionalPositiveIntegerQuery(value) ?? fallback;
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
