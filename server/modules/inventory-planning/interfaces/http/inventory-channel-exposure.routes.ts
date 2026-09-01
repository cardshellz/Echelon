import type { Express, Request, Response } from "express";

import {
  channelExposureDraftSaveResultSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  saveChannelExposurePolicyDraftRequestSchema,
  savePublicationSourceBindingDraftRequestSchema,
} from "@shared/types/inventory-channel-exposure";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryChannelExposureAdminService,
  type InventoryChannelExposureAdminStore,
} from "../../application/inventory-channel-exposure-admin.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";

const positiveId = z.coerce.number().int().positive().max(2_147_483_647);
type ChannelExposureService = Pick<
  InventoryChannelExposureAdminService,
  "getView" | "savePolicyDraft" | "saveSourceBindingDraft" | "preview"
>;

export interface InventoryChannelExposureRouteDependencies {
  service?: ChannelExposureService;
  store?: InventoryChannelExposureAdminStore;
}

export function registerInventoryChannelExposureRoutes(
  app: Express,
  dependencies: InventoryChannelExposureRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryChannelExposureAdminService(
    dependencies.store ?? new PostgresInventoryChannelExposureAdminStore(),
  );

  app.get(
    "/api/inventory-planning/admin/channel-exposure",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        const productId = req.query.productId == null
          ? null
          : parseId(req.query.productId, "product");
        return res.json(inventoryChannelExposureAdminViewSchema.parse(await service.getView(productId)));
      } catch (error) {
        return sendError(res, error, "load channel inventory exposure");
      }
    },
  );

  app.get(
    "/api/inventory-planning/admin/channel-exposure/preview",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      try {
        return res.json(inventoryChannelExposurePreviewSchema.parse(await service.preview(
          parseId(req.query.publicationTargetId, "publication target"),
          parseId(req.query.productId, "product"),
        )));
      } catch (error) {
        return sendError(res, error, "preview channel inventory exposure");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/policy-draft",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = channelExposureDraftSaveResultSchema.parse(await service.savePolicyDraft(
          parseBody(saveChannelExposurePolicyDraftRequestSchema, req.body),
          auditActor(req),
        ));
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "save a channel-exposure policy draft");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/source-binding-draft",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = channelExposureDraftSaveResultSchema.parse(await service.saveSourceBindingDraft(
          parseBody(savePublicationSourceBindingDraftRequestSchema, req.body),
          auditActor(req),
        ));
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "save a publication source-binding draft");
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_REQUEST",
      "Review the channel-exposure request fields.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseId(value: unknown, label: string): number {
  const parsed = positiveId.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_CHANNEL_EXPOSURE_INVALID_IDENTIFIER",
      `The ${label} identifier is invalid.`,
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

function sendError(res: Response, error: unknown, action: string): Response {
  if (error instanceof InventoryAvailabilityMasterDataError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (isPostgresError(error, "40001") || isPostgresError(error, "40P01")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_CHANNEL_EXPOSURE_CONCURRENT_CHANGE",
        message: "A concurrent channel-exposure change prevented a deterministic save. Retry it.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "INVENTORY_CHANNEL_EXPOSURE_FAILED",
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: { code: "INVENTORY_CHANNEL_EXPOSURE_FAILED", message: `Failed to ${action}.` },
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code);
}
