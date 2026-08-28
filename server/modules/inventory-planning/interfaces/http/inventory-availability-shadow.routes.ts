import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  plannerShadowRunSchema,
  runPlannerShadowRequestSchema,
  type PlannerShadowRunDto,
} from "@shared/types/inventory-availability-planner";
import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryAvailabilityShadowService,
  InventoryAvailabilityShadowServiceError,
} from "../../application/inventory-availability-shadow.service";
import {
  InventoryAvailabilityShadowRepositoryError,
  PostgresInventoryAvailabilityShadowRepository,
} from "../../infrastructure/inventory-availability-shadow.repository";

const positiveIdSchema = z.coerce.number().pipe(
  z.number().int().positive().max(2_147_483_647),
);

type ShadowService = {
  runProductShadow(productId: number, input: unknown, actor: string): Promise<PlannerShadowRunDto>;
  getLatestProductShadow(productId: number): Promise<PlannerShadowRunDto>;
};

export interface InventoryAvailabilityShadowRouteDependencies {
  service?: ShadowService;
}

export function registerInventoryAvailabilityShadowRoutes(
  app: Express,
  dependencies: InventoryAvailabilityShadowRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryAvailabilityShadowService(
    new PostgresInventoryAvailabilityShadowRepository(),
  );

  app.post(
    "/api/inventory-planning/admin/supply-transformations/:productId/shadow-runs",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const productId = parseProductId(req.params.productId);
        const request = parseRequest(req.body);
        const result = plannerShadowRunSchema.parse(
          await service.runProductShadow(productId, request, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendShadowError(res, error, "run inventory availability shadow comparison");
      }
    },
  );

  app.get(
    "/api/inventory-planning/admin/supply-transformations/:productId/shadow-runs/latest",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        const result = plannerShadowRunSchema.parse(
          await service.getLatestProductShadow(parseProductId(req.params.productId)),
        );
        return res.json(result);
      } catch (error) {
        return sendShadowError(res, error, "load inventory availability shadow comparison");
      }
    },
  );
}

function parseProductId(value: string): number {
  const parsed = positiveIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityShadowServiceError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      "Invalid product identifier.",
    );
  }
  return parsed.data;
}

function parseRequest(value: unknown): z.infer<typeof runPlannerShadowRequestSchema> {
  const parsed = runPlannerShadowRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityShadowServiceError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_INPUT",
      "Review the shadow-run request fields.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new InventoryAvailabilityShadowServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return actor;
}

function sendShadowError(res: Response, error: unknown, action: string): Response {
  if (error instanceof InventoryAvailabilityShadowServiceError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (error instanceof InventoryAvailabilityShadowRepositoryError) {
    if (error.code === "PRODUCT_NOT_FOUND") {
      return res.status(404).json({
        error: { code: "INVENTORY_AVAILABILITY_PRODUCT_NOT_FOUND", message: error.message },
      });
    }
    if (error.code === "IDEMPOTENCY_KEY_REUSED") {
      return res.status(409).json({
        error: { code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_CONFLICT", message: error.message },
      });
    }
  }
  console.error(JSON.stringify({
    code: "INVENTORY_AVAILABILITY_SHADOW_FAILED",
    action,
    errorCode: error instanceof InventoryAvailabilityShadowRepositoryError
      ? error.code
      : error instanceof InventoryAvailabilityShadowServiceError
        ? error.code
        : null,
    errorName: error instanceof Error ? error.name : typeof error,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "INVENTORY_AVAILABILITY_SHADOW_FAILED",
      message: `Failed to ${action}.`,
    },
  });
}
