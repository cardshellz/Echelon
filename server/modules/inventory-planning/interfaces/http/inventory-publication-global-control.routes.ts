import type { Express, Request, Response } from "express";

import type { InventoryPublicationGlobalControlRequest } from "@shared/types/inventory-publication-global-control";

import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryPublicationGlobalControlService,
  type InventoryPublicationGlobalControlStore,
} from "../../application/inventory-publication-global-control.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { PostgresInventoryPublicationGlobalControlStore } from "../../infrastructure/inventory-publication-global-control.repository";

export interface InventoryPublicationGlobalControlRouteDependencies {
  service?: Pick<InventoryPublicationGlobalControlService, "change">;
  store?: InventoryPublicationGlobalControlStore;
}

export function registerInventoryPublicationGlobalControlRoutes(
  app: Express,
  dependencies: InventoryPublicationGlobalControlRouteDependencies = {},
): void {
  const service = dependencies.service ?? new InventoryPublicationGlobalControlService(
    dependencies.store ?? new PostgresInventoryPublicationGlobalControlStore(),
  );

  app.put(
    "/api/inventory-planning/admin/publication-global-control",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const result = await service.change(
          req.body as InventoryPublicationGlobalControlRequest,
          auditActor(req),
        );
        // The committed control change wakes the supervisor immediately, but a
        // potentially long publication sweep must not hold the HTTP command open.
        void req.app.locals.inventoryPublicationSweepScheduler?.refresh?.();
        return res.json(result);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_PUBLICATION_GLOBAL_CONTROL_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return actor;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof InventoryAvailabilityMasterDataError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (isPostgresError(error, "40001") || isPostgresError(error, "40P01")) {
    return res.status(409).json({
      error: {
        code: "PUBLICATION_GLOBAL_CONTROL_CONCURRENT_CHANGE",
        message: "A concurrent publication-control change prevented this command. Reload and retry.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "PUBLICATION_GLOBAL_CONTROL_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "PUBLICATION_GLOBAL_CONTROL_FAILED",
      message: "Failed to change the global inventory publication control.",
    },
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code);
}
