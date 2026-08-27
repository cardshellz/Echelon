import type { Express, Request, Response } from "express";
import {
  createTransformationModelDraftRequestSchema,
  createTransformationModelDraftResultSchema,
  inventoryPlanningProductOptionsQuerySchema,
  inventoryPlanningProductOptionsResponseSchema,
  locationPromisePolicyDraftResultSchema,
  promiseSafetyPolicyDraftResultSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
} from "@shared/types/inventory-availability-admin";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryAvailabilityMasterDataService,
  type InventoryAvailabilityMasterDataAdminStore,
} from "../../application/inventory-availability-master-data.service";
import {
  InventoryAvailabilityMasterDataError,
  locationPromisePolicyDraftSchema,
  promiseSafetyPolicyDraftSchema,
  safetyPolicyScopeSchema,
  safetyPolicyValueSchema,
} from "../../domain/inventory-availability-master-data.contracts";
import {
  PostgresInventoryAvailabilityMasterDataStore,
} from "../../infrastructure/inventory-availability-master-data.repository";

const positiveDatabaseIntegerSchema = z.number().int().positive().max(2_147_483_647);
const positiveIdSchema = z.coerce.number().pipe(positiveDatabaseIntegerSchema);
const draftMetadataSchema = z.object({
  changeReason: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
const locationDraftRequestSchema = locationPromisePolicyDraftSchema.extend(
  draftMetadataSchema.shape,
);
const safetyDraftRequestSchema = z.object({
  scope: safetyPolicyScopeSchema,
  value: safetyPolicyValueSchema,
  ...draftMetadataSchema.shape,
}).strict().superRefine((input, context) => {
  const definition = promiseSafetyPolicyDraftSchema.safeParse({
    scope: input.scope,
    value: input.value,
  });
  if (!definition.success) {
    definition.error.issues.forEach((issue) => context.addIssue(issue));
  }
});

type AdminService = Pick<
  InventoryAvailabilityMasterDataService,
  | "listProductOptions"
  | "getSupplyTransformationsAdminView"
  | "createTransformationModelDraft"
  | "updateTransformationModelDraft"
  | "createLocationPromisePolicyDraft"
  | "createPromiseSafetyPolicyDraft"
>;

export interface InventoryAvailabilityMasterDataRouteDependencies {
  service?: AdminService;
  store?: InventoryAvailabilityMasterDataAdminStore;
}

export function registerInventoryAvailabilityMasterDataRoutes(
  app: Express,
  dependencies: InventoryAvailabilityMasterDataRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryAvailabilityMasterDataService(
    dependencies.store ?? new PostgresInventoryAvailabilityMasterDataStore(),
  );

  app.get(
    "/api/inventory-planning/admin/products",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        const query = parseBody(inventoryPlanningProductOptionsQuerySchema, req.query);
        const payload = inventoryPlanningProductOptionsResponseSchema.parse(
          await service.listProductOptions(query),
        );
        return res.json(payload);
      } catch (error) {
        return sendAdminError(res, error, "load inventory-planning products");
      }
    },
  );

  app.get(
    "/api/inventory-planning/admin/supply-transformations/:productId",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        const payload = supplyTransformationsAdminViewSchema.parse(
          await service.getSupplyTransformationsAdminView(parseId(req.params.productId, "product")),
        );
        return res.json(payload);
      } catch (error) {
        return sendAdminError(res, error, "load supply and transformations");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/supply-transformations/:productId/drafts",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(createTransformationModelDraftRequestSchema, {
          ...req.body,
          productId: parseId(req.params.productId, "product"),
        });
        const result = createTransformationModelDraftResultSchema.parse(
          await service.createTransformationModelDraft(input, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendAdminError(res, error, "create transformation model draft");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/supply-transformations/:productId/drafts/:draftModelId",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const productId = parseId(req.params.productId, "product");
        const draftModelId = parseId(req.params.draftModelId, "draft model");
        const input = parseBody(updateTransformationModelDraftRequestSchema, req.body);
        const result = createTransformationModelDraftResultSchema.parse(
          await service.updateTransformationModelDraft(
            productId,
            draftModelId,
            input,
            auditActor(req),
          ),
        );
        return res.status(200).json(result);
      } catch (error) {
        return sendAdminError(res, error, "update transformation model draft");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/location-promise-policies/drafts",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(locationDraftRequestSchema, req.body);
        const result = locationPromisePolicyDraftResultSchema.parse(
          await service.createLocationPromisePolicyDraft(input, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendAdminError(res, error, "create location promise-policy draft");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/promise-safety-policies/drafts",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(safetyDraftRequestSchema, req.body);
        const result = promiseSafetyPolicyDraftResultSchema.parse(
          await service.createPromiseSafetyPolicyDraft(input, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendAdminError(res, error, "create promise-safety policy draft");
      }
    },
  );
}

function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_INPUT",
      "Review the inventory availability fields.",
      parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseId(value: string, label: string): number {
  const parsed = positiveIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      `Invalid ${label} identifier.`,
    );
  }
  return parsed.data;
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return actor;
}

function sendAdminError(
  res: Response,
  error: unknown,
  action: string,
): Response {
  if (error instanceof InventoryAvailabilityMasterDataError) {
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
        code: "INVENTORY_AVAILABILITY_CONFLICT",
        message: "The draft changed concurrently or already exists.",
      },
    });
  }
  if (isPostgresError(error, "23503") || isPostgresError(error, "23514")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_AVAILABILITY_REFERENCE_CHANGED",
        message: "A referenced product, variant, recipe, warehouse, or location changed.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "INVENTORY_AVAILABILITY_ADMIN_FAILED",
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "INVENTORY_AVAILABILITY_ADMIN_FAILED",
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
