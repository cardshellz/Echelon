import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipError } from "../../domain/errors";
import type { DropshipReturnService } from "../../application/dropship-return-service";
import { createDropshipReturnServiceFromEnv } from "../../infrastructure/dropship-return.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

type SessionUser = {
  id: string;
};

export function registerDropshipReturnRoutes(
  app: Express,
  service: DropshipReturnService = createDropshipReturnServiceFromEnv(),
): void {
  app.get("/api/dropship/returns", requireDropshipAuth, async (req, res) => {
    try {
      const result = await service.listForMember(req.session.dropship!.memberId, {
        statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
        search: parseOptionalStringQuery(req.query.search),
        page: parsePositiveIntegerQuery(req.query.page, 1),
        limit: parsePositiveIntegerQuery(req.query.limit, 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipReturnError(res, error);
    }
  });

  app.get("/api/dropship/returns/:rmaId", requireDropshipAuth, async (req, res) => {
    try {
      const rma = await service.getForMember(
        req.session.dropship!.memberId,
        parsePositiveInteger(req.params.rmaId, "rmaId"),
      );
      return res.json({ rma });
    } catch (error) {
      return sendDropshipReturnError(res, error);
    }
  });

  app.get("/api/dropship/admin/returns", requirePermission("dropship", "view"), async (req, res) => {
    try {
      const result = await service.listForAdmin({
        vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
        statuses: parseStatusesQuery(req.query.statuses ?? req.query.status),
        search: parseOptionalStringQuery(req.query.search),
        page: parsePositiveIntegerQuery(req.query.page, 1),
        limit: parsePositiveIntegerQuery(req.query.limit, 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipReturnError(res, error);
    }
  });

  app.post("/api/dropship/admin/returns", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      const result = await service.createRma({
        ...req.body,
        idempotencyKey: resolveIdempotencyKey(req),
        actor: adminActor(req),
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return sendDropshipReturnError(res, error);
    }
  });

  app.get("/api/dropship/admin/returns/:rmaId", requirePermission("dropship", "view"), async (req, res) => {
    try {
      const rma = await service.getForAdmin(parsePositiveInteger(req.params.rmaId, "rmaId"));
      return res.json({ rma });
    } catch (error) {
      return sendDropshipReturnError(res, error);
    }
  });

  app.post(
    "/api/dropship/admin/returns/:rmaId/status",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const rma = await service.updateStatus({
          rmaId: parsePositiveInteger(req.params.rmaId, "rmaId"),
          status: req.body?.status,
          notes: req.body?.notes ?? null,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json({ rma });
      } catch (error) {
        return sendDropshipReturnError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/returns/:rmaId/inspection",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.processInspection({
          ...req.body,
          rmaId: parsePositiveInteger(req.params.rmaId, "rmaId"),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipReturnError(res, error);
      }
    },
  );
}

function sendDropshipReturnError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipReturnError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipReturnRoutes] Unexpected return error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_RETURN_INTERNAL_ERROR",
      message: "Dropship return request failed.",
    },
  });
}

function statusForDropshipReturnError(code: string): number {
  switch (code) {
    case "DROPSHIP_RETURN_LIST_INVALID_INPUT":
    case "DROPSHIP_RETURN_CREATE_INVALID_INPUT":
    case "DROPSHIP_RETURN_STATUS_INVALID_INPUT":
    case "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT":
    case "DROPSHIP_RETURN_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
      return 403;
    case "DROPSHIP_RMA_NOT_FOUND":
    case "DROPSHIP_VENDOR_NOT_FOUND":
    case "DROPSHIP_STORE_CONNECTION_NOT_FOUND":
    case "DROPSHIP_ORDER_INTAKE_NOT_FOUND":
    case "DROPSHIP_RMA_ITEM_NOT_FOUND":
      return 404;
    case "DROPSHIP_RMA_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_RMA_ALREADY_INSPECTED":
      return 409;
    case "DROPSHIP_WALLET_INSUFFICIENT_FUNDS":
      return 402;
    case "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE":
    case "DROPSHIP_WALLET_CURRENCY_MISMATCH":
      return 409;
    default:
      return 500;
  }
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_RETURN_INVALID_REQUEST",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  return {
    actorType: "admin",
    actorId: sessionUser(req)?.id,
  };
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
  if (!parsed) return undefined;
  return parsed.split(",").map((status) => status.trim()).filter(Boolean);
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) return undefined;
  const number = Number(parsed);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function parsePositiveIntegerQuery(value: unknown, fallback: number): number {
  return parseOptionalPositiveIntegerQuery(value) ?? fallback;
}

function parsePositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_RETURN_INVALID_REQUEST", "Route parameter must be a positive integer.", {
      key,
      value,
    });
  }
  return parsed;
}
