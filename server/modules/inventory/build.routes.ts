import type { Express, Request, Response } from "express";
import { requirePermission } from "../../routes/middleware";
import { BuildDomainError } from "./domain/build.domain";

function actorId(req: Request): string | undefined {
  return req.session.user?.id;
}

function respondWithBuildError(res: Response, error: unknown): void {
  if (error instanceof BuildDomainError) {
    const status = error.code.endsWith("_NOT_FOUND")
      ? 404
      : error.code === "IDEMPOTENCY_KEY_REUSED" || error.code === "INVALID_BUILD_STATUS"
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
      const result = await req.app.locals.services.builds.executeOrder(Number(req.params.id), actorId(req));
      res.json(result);
    } catch (error) {
      respondWithBuildError(res, error);
    }
  });
}
