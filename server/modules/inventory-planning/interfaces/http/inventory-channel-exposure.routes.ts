import type { Express, Request, Response } from "express";

import {
  inventoryPublicationTargetResumeResultSchema,
  inventoryPublicationTargetResumeReviewSchema,
  resumeInventoryPublicationTargetRequestSchema,
  reviewInventoryPublicationTargetResumeRequestSchema,
} from "@shared/types/inventory-publication-target-resume";
import {
  channelExposureDraftSaveResultSchema,
  createInventoryPublicationTargetRequestSchema,
  holdInventoryPublicationTargetsRequestSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  inventoryPublicationTargetCommandResultSchema,
  inventoryPublicationTargetHoldResultSchema,
  saveChannelExposurePolicyDraftRequestSchema,
  savePublicationSourceBindingDraftRequestSchema,
  savePublicationVariantMappingDraftRequestSchema,
  setInventoryPublicationTargetPreviewStateRequestSchema,
  setUpChannelDestinationsRequestSchema,
  setUpChannelDestinationsResultSchema,
  stopInventoryPublicationTargetRequestSchema,
} from "@shared/types/inventory-channel-exposure";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryChannelExposureAdminService,
  type DropshipDestinationChannelResolver,
  type InventoryChannelExposureAdminStore,
} from "../../application/inventory-channel-exposure-admin.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";
import { pool } from "../../../../db";
import { createDropshipOmsChannelResolver } from "../../../dropship/infrastructure/dropship-oms-warehouse-assignments.reader";
import { InventoryPublicationTargetStopService } from "../../application/inventory-publication-target-stop.service";
import { PostgresInventoryPublicationTargetStopStore } from "../../infrastructure/inventory-publication-target-stop.repository";
import { InventoryPublicationTargetResumeService } from "../../application/inventory-publication-target-resume.service";
import { PostgresInventoryPublicationTargetResumeStore } from "../../infrastructure/inventory-publication-target-resume.repository";
import { InventoryPublicationTargetHoldService } from "../../application/inventory-publication-target-hold.service";
import { PostgresInventoryPublicationTargetHoldStore } from "../../infrastructure/inventory-publication-target-hold.repository";
import { ChannelPublicationStatusService } from "../../application/inventory-channel-publication-status.service";
import { PostgresChannelPublicationStatusReader } from "../../infrastructure/inventory-channel-publication-status.repository";

const positiveId = z.coerce.number().int().positive().max(2_147_483_647);
type ChannelExposureService = Pick<
  InventoryChannelExposureAdminService,
  "getView" | "savePolicyDraft" | "saveSourceBindingDraft" | "preview"
  | "createPublicationTarget" | "setPublicationTargetPreviewState" | "saveVariantMappingDraft"
  | "setUpChannelDestinations"
>;

export interface InventoryChannelExposureRouteDependencies {
  service?: ChannelExposureService;
  store?: InventoryChannelExposureAdminStore;
  targetStopService?: Pick<InventoryPublicationTargetStopService, "stop">;
  targetResumeService?: Pick<InventoryPublicationTargetResumeService, "review" | "resume">;
  targetHoldService?: Pick<InventoryPublicationTargetHoldService, "hold" | "release">;
  dropshipChannel?: DropshipDestinationChannelResolver;
  publicationStatusService?: Pick<ChannelPublicationStatusService, "read">;
}

export function registerInventoryChannelExposureRoutes(
  app: Express,
  dependencies: InventoryChannelExposureRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryChannelExposureAdminService(
    dependencies.store ?? new PostgresInventoryChannelExposureAdminStore(),
    undefined,
    // Dropship owns the definition of its single internal channel; this page
    // reads it through that module's resolver instead of re-deriving the rule.
    dependencies.dropshipChannel ?? createDropshipOmsChannelResolver(pool),
  );
  const targetStopService = dependencies.targetStopService
    ?? new InventoryPublicationTargetStopService(new PostgresInventoryPublicationTargetStopStore());
  const targetResumeService = dependencies.targetResumeService
    ?? new InventoryPublicationTargetResumeService(new PostgresInventoryPublicationTargetResumeStore());
  const targetHoldService = dependencies.targetHoldService
    ?? new InventoryPublicationTargetHoldService(new PostgresInventoryPublicationTargetHoldStore());
  const publicationStatusService = dependencies.publicationStatusService
    ?? new ChannelPublicationStatusService(new PostgresChannelPublicationStatusReader(pool));

  app.get(
    "/api/inventory-planning/admin/channel-exposure/publication-status",
    requirePermission("inventory_planning", "view"),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        return res.json(await publicationStatusService.read({
          publicationTargetId: parseId(req.query.publicationTargetId, "publication target"),
          productId: parseId(req.query.productId, "product"),
        }));
      } catch (error) {
        return sendError(res, error, "read recorded publication status");
      }
    },
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

  app.post(
    "/api/inventory-planning/admin/channel-exposure/publication-target-resume-review",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        const result = inventoryPublicationTargetResumeReviewSchema.parse(
          await targetResumeService.review(
            parseBody(reviewInventoryPublicationTargetResumeRequestSchema, req.body),
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "review a stopped publication target for resume");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/channel-exposure/publication-target-resume",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        return res.json(inventoryPublicationTargetResumeResultSchema.parse(
          await targetResumeService.resume(
            parseBody(resumeInventoryPublicationTargetRequestSchema, req.body),
            auditActor(req),
          ),
        ));
      } catch (error) {
        return sendError(res, error, "resume a stopped publication target");
      }
    },
  );

  // A hold keeps a live destination publishing, at zero, and a release
  // restores its quantities: both change what the marketplace sells, so they
  // carry the activation permission like stop and resume.
  app.put(
    "/api/inventory-planning/admin/channel-exposure/publication-target-hold",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        return res.json(inventoryPublicationTargetHoldResultSchema.parse(
          await targetHoldService.hold(
            parseBody(holdInventoryPublicationTargetsRequestSchema, req.body),
            auditActor(req),
          ),
        ));
      } catch (error) {
        return sendError(res, error, "hold a publication destination at zero");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/publication-target-release",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        return res.json(inventoryPublicationTargetHoldResultSchema.parse(
          await targetHoldService.release(
            parseBody(holdInventoryPublicationTargetsRequestSchema, req.body),
            auditActor(req),
          ),
        ));
      } catch (error) {
        return sendError(res, error, "release a held publication destination");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/publication-target-stop",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        return res.json(inventoryPublicationTargetCommandResultSchema.parse(
          await targetStopService.stop(
            parseBody(stopInventoryPublicationTargetRequestSchema, req.body),
            auditActor(req),
          ),
        ));
      } catch (error) {
        return sendError(res, error, "stop a live publication target");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/channel-exposure/channel-destinations",
    // Setup, not activation: every target is created disabled, so this carries
    // the same edit permission as registering one destination by hand.
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = setUpChannelDestinationsResultSchema.parse(
          await service.setUpChannelDestinations(
            parseBody(setUpChannelDestinationsRequestSchema, req.body),
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "set up channel destinations");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/channel-exposure/publication-target",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = inventoryPublicationTargetCommandResultSchema.parse(
          await service.createPublicationTarget(
            parseBody(createInventoryPublicationTargetRequestSchema, req.body),
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "create a disabled publication target");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/publication-target-preview-state",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        return res.json(inventoryPublicationTargetCommandResultSchema.parse(
          await service.setPublicationTargetPreviewState(
            parseBody(setInventoryPublicationTargetPreviewStateRequestSchema, req.body),
            auditActor(req),
          ),
        ));
      } catch (error) {
        return sendError(res, error, "change publication-target preview state");
      }
    },
  );

  app.put(
    "/api/inventory-planning/admin/channel-exposure/variant-mapping-draft",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = channelExposureDraftSaveResultSchema.parse(
          await service.saveVariantMappingDraft(
            parseBody(savePublicationVariantMappingDraftRequestSchema, req.body),
            auditActor(req),
          ),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error, "save an exact target/SKU mapping draft");
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

function parseBody<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
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
