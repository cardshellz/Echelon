import { createHash } from "node:crypto";

import {
  claimPlanRequestSchema,
  claimPlanSchema,
  type ClaimSupplySnapshotDto,
  type ClaimPlanDto,
  type ClaimPlanRequestDto,
} from "@shared/types/inventory-availability-planner";
import {
  plannerClaimSimulationRunSchema,
  runPlannerClaimSimulationRequestSchema,
  type PlannerClaimSimulationRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { planCanonicalClaim } from "../domain/inventory-availability-planner";
import type { InventoryAvailabilityClaimSnapshotStore } from "../infrastructure/inventory-availability-shadow.repository";

const actorSchema = z.string().trim().min(1).max(100);

export interface PersistClaimSimulationInput {
  snapshot: ClaimSupplySnapshotDto;
  claim: ClaimPlanRequestDto;
  plan: ClaimPlanDto;
  requestHash: string;
  idempotencyKey: string;
  reason: string;
  requestedBy: string;
  completedAt: Date;
}

export interface InventoryAvailabilityClaimSimulationStore {
  persistClaimSimulation(input: PersistClaimSimulationInput): Promise<PlannerClaimSimulationRun>;
}

export interface InventoryAvailabilityClaimSimulationClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityClaimSimulationClock = { now: () => new Date() };

export class InventoryAvailabilityClaimSimulationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityClaimSimulationServiceError";
  }
}

export class InventoryAvailabilityClaimSimulationService {
  constructor(
    private readonly snapshotStore: InventoryAvailabilityClaimSnapshotStore,
    private readonly simulationStore: InventoryAvailabilityClaimSimulationStore,
    private readonly clock: InventoryAvailabilityClaimSimulationClock = systemClock,
  ) {}

  async runSimulation(input: unknown, actorInput: string): Promise<PlannerClaimSimulationRun> {
    const parsed = runPlannerClaimSimulationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new InventoryAvailabilityClaimSimulationServiceError(
        400,
        "INVENTORY_AVAILABILITY_INVALID_CLAIM_SIMULATION",
        "Review the whole-order claim-simulation fields.",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = parseActor(actorInput);
    const claim = claimPlanRequestSchema.parse(parsed.data.claim);
    const snapshot = await this.snapshotStore.captureClaimSupplySnapshot(
      claim.lines.map((line) => line.targetVariantId),
    );
    const plan = claimPlanSchema.parse(planCanonicalClaim(snapshot, claim));
    const completedAt = this.clock.now();
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
      throw new InventoryAvailabilityClaimSimulationServiceError(
        500,
        "INVENTORY_AVAILABILITY_INVALID_CLOCK",
        "The injected claim-simulation clock returned an invalid time.",
      );
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "inventory_availability_claim_simulation",
      requestedBy: actor,
      reason: parsed.data.reason,
      claim,
    }), "utf8").digest("hex");
    return plannerClaimSimulationRunSchema.parse(
      await this.simulationStore.persistClaimSimulation({
        snapshot,
        claim,
        plan,
        requestHash,
        idempotencyKey: parsed.data.idempotencyKey,
        reason: parsed.data.reason,
        requestedBy: actor,
        completedAt,
      }),
    );
  }
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityClaimSimulationServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}
