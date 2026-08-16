import type { Express, Request, Response } from "express";
import { requirePermission } from "../../routes/middleware";
import { BuildDomainError } from "./domain/build.domain";

function actorId(req: Request): string | undefined {
  return req.session.user?.id;
}

const BUILD_CONFLICT_CODES = new Set([
  "BUILD_CANCELLATION_CONFLICT",
  "BUILD_COST_NOT_CONSERVED",
  "BUILD_LOT_LEVEL_MISMATCH",
  "BUILD_OUTPUT_ALREADY_USED",
  "BUILD_OUTPUT_LEVEL_DRIFT",
  "BUILD_OUTPUT_LOTS_MISSING",
  "BUILD_RESERVATION_DRIFT",
  "BUILD_RESERVATION_MISSING",
  "BUILD_RESERVATION_OVERALLOCATED",
  "BUILD_REVERSAL_LEVEL_MISSING",
  "BUILD_REVERSAL_NOT_LATEST_RUN",
  "BUILD_REVERSAL_SOURCE_DRIFT",
  "BUILD_RUN_ALREADY_REVERSED",
  "BUILD_RUN_INCOMPLETE",
  "IDEMPOTENCY_KEY_REUSED",
  "INSUFFICIENT_BUILD_COMPONENT",
  "INVALID_BUILD_STATUS",
]);

function respondWithBuildError(res: Response, error: unknown): void {
  if (error instanceof BuildDomainError) {
    const status = error.code.endsWith("_NOT_FOUND")
      ? 404
      : BUILD_CONFLICT_CODES.has(error.code)
        ? 409
        : 400;
    res.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
    return;
  }

  const dbError = error as { code?: string; constraint?: string };
  if (dbError?.code === "23505") {
    res.status(409).json({
      error: {
        code: "BUILD_CONFLICT",
        message: "A build record with the same unique identity already exists",
        context: { constraint: dbError.constraint ?? null },
      },
    });
    return;
  }

  console.error(JSON.stringify({
    event: "build_request_failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  res.status(500).json({
    error: {
      code: "BUILD_INTERNAL_ERROR",
      message: "The build operation could not be completed",
      context: {},
    },
  });
}

export function registerBuildRoutes(app: Express): void {
  app.get(
    "/api/inventory/build-relationships/products/:productId",
    requirePermission("inventory", "view"),
    async (req, res) => {
      try {
        res.json(
          await req.app.locals.services.builds.listProductRelationships(Number(req.params.productId)),
        );
      } catch (error) {
        respondWithBuildError(res, error);
      }
    },
  );
  app.get("/api/inventory/build-recipes", requirePermission("inventory", "view"), async (req, res) => {
    try {
      res.json(await req.app.locals.services.builds.listRecipes());
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.get("/api/inventory/build-orders", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseId = req.query.warehouseId == null ? undefined : Number(req.query.warehouseId);
      res.json(await req.app.locals.services.builds.listOrders(warehouseId));
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.get("/api/inventory/build-orders/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      res.json(await req.app.locals.services.builds.getOrder(Number(req.params.id)));
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post("/api/inventory/build-recipes", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const recipe = await req.app.locals.services.builds.createRecipe({
        ...req.body,
        actorId: actorId(req),
      });
      res.status(201).json(recipe);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post("/api/inventory/build-orders", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const idempotencyKey = req.get("Idempotency-Key") ?? req.body?.idempotencyKey;
      const order = await req.app.locals.services.builds.createOrder({
        ...req.body,
        idempotencyKey,
        actorId: actorId(req),
      });
      res.status(201).json(order);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post("/api/inventory/build-orders/:id/release", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const order = await req.app.locals.services.builds.releaseOrder(Number(req.params.id), actorId(req));
      res.json(order);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post("/api/inventory/build-orders/:id/execute", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const idempotencyKey = req.get("Idempotency-Key") ?? req.body?.idempotencyKey;
      const result = await req.app.locals.services.builds.executeOrder({
        buildOrderId: Number(req.params.id),
        buildsCompleted: req.body?.buildsCompleted,
        idempotencyKey,
        actorId: actorId(req),
      });
      res.json(result);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post("/api/inventory/build-orders/:id/cancel", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const result = await req.app.locals.services.builds.cancelOrder({
        buildOrderId: Number(req.params.id),
        reason: req.body?.reason,
        actorId: actorId(req),
      });
      res.json(result);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });

  app.post(
    "/api/inventory/build-orders/:id/runs/:runId/reverse",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      try {
        const idempotencyKey = req.get("Idempotency-Key") ?? req.body?.idempotencyKey;
        const result = await req.app.locals.services.builds.reverseRun({
          buildOrderId: Number(req.params.id),
          buildRunId: Number(req.params.runId),
          idempotencyKey,
          reason: req.body?.reason,
          actorId: actorId(req),
        });
        res.json(result);
      } catch (error) {
        respondWithBuildError(res, error);
      }
    },
  );
}
