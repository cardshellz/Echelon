import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  applyInventoryAvailabilityBackfillDraftResultSchema,
  inventoryAvailabilityBackfillQueueResponseSchema,
  inventoryAvailabilityChannelPreviewSchema,
  refreshInventoryAvailabilityBackfillDraftResultSchema,
  reviewInventoryAvailabilityBackfillDraftResultSchema,
} from "@shared/types/inventory-availability-backfill";

import { requirePermission } from "../../../../routes/middleware";
import { InventoryCatalogBatchService } from "../../application/inventory-catalog-batch.service";
import { inventoryCatalogBatchPreviewSchema, inventoryCatalogBatchResultSchema } from "@shared/types/inventory-catalog-batch";
import { InventoryAvailabilityBackfillService } from "../../application/inventory-availability-backfill.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { PostgresInventoryAvailabilityBackfillRepository } from "../../infrastructure/inventory-availability-backfill.repository";
import { PostgresInventoryAvailabilityChannelPreviewRepository } from "../../infrastructure/inventory-availability-channel-preview.repository";
import { PostgresInventoryAvailabilityMasterDataStore } from "../../infrastructure/inventory-availability-master-data.repository";

const positiveIdSchema = z.coerce.number().pipe(
  z.number().int().positive().max(2_147_483_647),
);

type BackfillService = Pick<
  InventoryAvailabilityBackfillService,
  | "getMigrationQueue"
  | "applyProductDraft"
  | "refreshProductDraft"
  | "reviewProductDraft"
  | "getChannelPreview"
>;

export interface InventoryAvailabilityBackfillRouteDependencies {
  service?: BackfillService;
}

export function registerInventoryAvailabilityBackfillRoutes(
  app: Express,
  dependencies: InventoryAvailabilityBackfillRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryAvailabilityBackfillService(
    new PostgresInventoryAvailabilityBackfillRepository(),
    new PostgresInventoryAvailabilityMasterDataStore(),
    new PostgresInventoryAvailabilityChannelPreviewRepository(),
  );
  const batch = new InventoryCatalogBatchService(service);

  app.post("/api/inventory-planning/admin/migration-queue/batch/preview",
    requirePermission("inventory_planning", "view"), async (req, res) => {
      try {
        return res.json(inventoryCatalogBatchPreviewSchema.parse(await batch.preview(req.body)));
      } catch (error) {
        return sendBackfillError(res, error, "preview a catalog batch");
      }
    });
  app.post("/api/inventory-planning/admin/migration-queue/batch/execute",
    requirePermission("inventory_planning", "edit"), async (req, res) => {
      try {
        return res.json(inventoryCatalogBatchResultSchema.parse(await batch.execute(req.body, auditActor(req))));
      } catch (error) {
        return sendBackfillError(res, error, "execute a catalog batch");
      }
    });

  app.get(
    "/api/inventory-planning/admin/migration-queue",
    requirePermission("inventory_planning", "view"),
    async (_req, res) => {
      try {
        return res.json(inventoryAvailabilityBackfillQueueResponseSchema.parse(
          await service.getMigrationQueue(),
        ));
      } catch (error) {
        return sendBackfillError(res, error, "load the inventory availability migration queue");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/migration-queue/:productId/drafts/:draftModelId/refresh",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = refreshInventoryAvailabilityBackfillDraftResultSchema.parse(
          await service.refreshProductDraft(
            parseProductId(req.params.productId),
            parseProductId(req.params.draftModelId),
            req.body,
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendBackfillError(res, error, "supersede and refresh a stale Phase 3 draft");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/migration-queue/:productId/drafts",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = applyInventoryAvailabilityBackfillDraftResultSchema.parse(
          await service.applyProductDraft(
            parseProductId(req.params.productId),
            req.body,
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendBackfillError(res, error, "create a deterministic transformation draft");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/migration-queue/:productId/reviews",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = reviewInventoryAvailabilityBackfillDraftResultSchema.parse(
          await service.reviewProductDraft(
            parseProductId(req.params.productId),
            req.body,
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendBackfillError(res, error, "record transformation-draft review evidence");
      }
    },
  );

  app.get(
    "/api/inventory-planning/admin/migration-queue/:productId/channel-preview",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        return res.json(inventoryAvailabilityChannelPreviewSchema.parse(
          await service.getChannelPreview(parseProductId(req.params.productId)),
        ));
      } catch (error) {
        return sendBackfillError(res, error, "preview channel publication quantities");
      }
    },
  );
}

function parseProductId(value: string): number {
  const parsed = positiveIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      "Invalid product identifier.",
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

function sendBackfillError(res: Response, error: unknown, action: string): Response {
  if (error instanceof InventoryAvailabilityMasterDataError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (isPostgresError(error, "23505")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_AVAILABILITY_CONFLICT",
        message: "The draft or review evidence changed concurrently.",
      },
    });
  }
  if (isPostgresError(error, "40001") || isPostgresError(error, "40P01")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_AVAILABILITY_CONCURRENT_CHANGE",
        message: "A concurrent change prevented a deterministic write; reload and retry.",
      },
    });
  }
  if (isPostgresError(error, "23503") || isPostgresError(error, "23514")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_AVAILABILITY_REFERENCE_CHANGED",
        message: "A referenced product, variant, recipe, draft, or model changed.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "INVENTORY_AVAILABILITY_BACKFILL_FAILED",
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "INVENTORY_AVAILABILITY_BACKFILL_FAILED",
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
