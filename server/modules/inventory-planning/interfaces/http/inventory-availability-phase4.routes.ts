import type { Express, Request, Response } from "express";

import {
  inventoryActivationDryRunSchema,
  plannerClaimSimulationRunSchema,
} from "@shared/types/inventory-availability-phase4";

import { requirePermission } from "../../../../routes/middleware";
import {
  InventoryAvailabilityClaimSimulationService,
  InventoryAvailabilityClaimSimulationServiceError,
} from "../../application/inventory-availability-claim-simulation.service";
import {
  InventoryAvailabilityActivationDryRunService,
  InventoryAvailabilityActivationDryRunServiceError,
} from "../../application/inventory-availability-activation-dry-run.service";
import { InventoryAvailabilityBackfillService } from "../../application/inventory-availability-backfill.service";
import {
  InventoryAvailabilityActivationDryRunRepositoryError,
  PostgresInventoryAvailabilityActivationDryRunRepository,
} from "../../infrastructure/inventory-availability-activation-dry-run.repository";
import { PostgresInventoryAvailabilityBackfillRepository } from "../../infrastructure/inventory-availability-backfill.repository";
import { PostgresInventoryAvailabilityChannelPreviewRepository } from "../../infrastructure/inventory-availability-channel-preview.repository";
import { PostgresInventoryAvailabilityMasterDataStore } from "../../infrastructure/inventory-availability-master-data.repository";
import {
  InventoryAvailabilityClaimSimulationRepositoryError,
  PostgresInventoryAvailabilityClaimSimulationRepository,
} from "../../infrastructure/inventory-availability-claim-simulation.repository";
import {
  InventoryAvailabilityShadowRepositoryError,
  PostgresInventoryAvailabilityShadowRepository,
} from "../../infrastructure/inventory-availability-shadow.repository";

type Phase4Service = Pick<InventoryAvailabilityClaimSimulationService, "runSimulation">;
type ActivationDryRunService = Pick<InventoryAvailabilityActivationDryRunService, "runDryRun">;

export interface InventoryAvailabilityPhase4RouteDependencies {
  claimSimulationService?: Phase4Service;
  activationDryRunService?: ActivationDryRunService;
}

export function registerInventoryAvailabilityPhase4Routes(
  app: Express,
  dependencies: InventoryAvailabilityPhase4RouteDependencies = {},
): void {
  const snapshotStore = new PostgresInventoryAvailabilityShadowRepository();
  const claimSimulationService = dependencies.claimSimulationService
    ?? new InventoryAvailabilityClaimSimulationService(
      snapshotStore,
      new PostgresInventoryAvailabilityClaimSimulationRepository(),
    );
  const activationDryRunRepository = new PostgresInventoryAvailabilityActivationDryRunRepository();
  const activationDryRunService = dependencies.activationDryRunService
    ?? new InventoryAvailabilityActivationDryRunService(
      new InventoryAvailabilityBackfillService(
        new PostgresInventoryAvailabilityBackfillRepository(),
        new PostgresInventoryAvailabilityMasterDataStore(),
        new PostgresInventoryAvailabilityChannelPreviewRepository(snapshotStore),
      ),
      activationDryRunRepository,
    );

  app.post(
    "/api/inventory-planning/admin/claim-simulations",
    requirePermission("inventory_planning", "edit"),
    async (req, res) => {
      try {
        const result = plannerClaimSimulationRunSchema.parse(
          await claimSimulationService.runSimulation(req.body, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendPhase4Error(res, error, "run a whole-order claim simulation");
      }
    },
  );

  app.post(
    "/api/inventory-planning/admin/activation-runs/dry-run",
    requirePermission("inventory_planning", "activate"),
    async (req, res) => {
      try {
        const result = inventoryActivationDryRunSchema.parse(
          await activationDryRunService.runDryRun(req.body, auditActor(req)),
        );
        return res.status(result.alreadyApplied ? 200 : 201).json(result);
      } catch (error) {
        return sendPhase4Error(res, error, "run the full-catalog activation dry run");
      }
    },
  );
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new InventoryAvailabilityClaimSimulationServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return actor;
}

function sendPhase4Error(res: Response, error: unknown, action: string): Response {
  if (error instanceof InventoryAvailabilityClaimSimulationServiceError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (error instanceof InventoryAvailabilityActivationDryRunServiceError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (error instanceof InventoryAvailabilityClaimSimulationRepositoryError) {
    if (error.code === "IDEMPOTENCY_KEY_REUSED") {
      return res.status(409).json({
        error: { code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_CONFLICT", message: error.message },
      });
    }
  }
  if (error instanceof InventoryAvailabilityShadowRepositoryError
    && error.code === "TARGET_VARIANT_NOT_FOUND") {
    return res.status(404).json({
      error: { code: "INVENTORY_AVAILABILITY_TARGET_VARIANT_NOT_FOUND", message: error.message },
    });
  }
  if (error instanceof InventoryAvailabilityActivationDryRunRepositoryError
    && error.code === "IDEMPOTENCY_KEY_REUSED") {
    return res.status(409).json({
      error: { code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_CONFLICT", message: error.message },
    });
  }
  if (isPostgresError(error, "40001") || isPostgresError(error, "40P01")) {
    return res.status(409).json({
      error: {
        code: "INVENTORY_AVAILABILITY_CONCURRENT_CHANGE",
        message: "A concurrent change prevented deterministic evidence capture; retry the request.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "INVENTORY_AVAILABILITY_PHASE4_FAILED",
    action,
    errorCode: error instanceof InventoryAvailabilityClaimSimulationRepositoryError
      ? error.code
      : error instanceof InventoryAvailabilityClaimSimulationServiceError
        ? error.code
        : error instanceof InventoryAvailabilityActivationDryRunRepositoryError
          ? error.code
          : error instanceof InventoryAvailabilityActivationDryRunServiceError
            ? error.code
            : error instanceof InventoryAvailabilityShadowRepositoryError
              ? error.code
              : null,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: { code: "INVENTORY_AVAILABILITY_PHASE4_FAILED", message: `Failed to ${action}.` },
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
