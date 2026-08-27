import { z } from "zod";

import {
  atpProjectionRequestSchema,
  plannerShadowRunSchema,
  runPlannerShadowRequestSchema,
  type PlannerShadowResultDto,
  type PlannerShadowRunDto,
} from "@shared/types/inventory-availability-planner";
import {
  calculateLegacyAtpFromSnapshot,
  classifyShadowDifference,
  projectCanonicalAtp,
} from "../domain/inventory-availability-planner";
import type {
  InventoryAvailabilityShadowStore,
} from "../infrastructure/inventory-availability-shadow.repository";

const positiveDatabaseIntegerSchema = z.number().int().positive().max(2_147_483_647);
const actorSchema = z.string().trim().min(1).max(100);

export interface InventoryAvailabilityShadowClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityShadowClock = {
  now: () => new Date(),
};

export class InventoryAvailabilityShadowServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityShadowServiceError";
  }
}

export class InventoryAvailabilityShadowService {
  constructor(
    private readonly store: InventoryAvailabilityShadowStore,
    private readonly clock: InventoryAvailabilityShadowClock = systemClock,
  ) {}

  async runProductShadow(
    productIdInput: number,
    input: unknown,
    actorInput: string,
  ): Promise<PlannerShadowRunDto> {
    const productId = parseProductId(productIdInput);
    const request = parseRequest(input);
    const actor = parseActor(actorInput);
    const snapshot = await this.store.captureSupplySnapshot(productId);
    const variants = snapshot.variants
      .filter((variant) => variant.productId === productId && variant.isActive)
      .sort((left, right) => left.id - right.id);
    if (variants.length === 0) {
      throw new InventoryAvailabilityShadowServiceError(
        409,
        "INVENTORY_AVAILABILITY_NO_ACTIVE_VARIANTS",
        "The product has no active variants to compare.",
      );
    }
    const warehouseScopes = snapshot.warehouses
      .filter((warehouse) => warehouse.isActive)
      .sort((left, right) => left.id - right.id)
      .map((warehouse) => ({ kind: "warehouse" as const, warehouseId: warehouse.id }));
    const warehouseCodes = new Map(snapshot.warehouses.map((warehouse) =>
      [warehouse.id, warehouse.code] as const));
    const scopes = [{ kind: "network" as const }, ...warehouseScopes];
    const results: PlannerShadowResultDto[] = [];
    for (const scope of scopes) {
      for (const variant of variants) {
        const projectionRequest = atpProjectionRequestSchema.parse({
          targetVariantId: variant.id,
          scope,
        });
        const proposedProjection = projectCanonicalAtp(snapshot, projectionRequest);
        const legacyAtp = calculateLegacyAtpFromSnapshot(snapshot, projectionRequest);
        const proposedAtp = BigInt(proposedProjection.atpUnits);
        results.push({
          warehouseId: scope.kind === "warehouse" ? scope.warehouseId : null,
          warehouseCodeSnapshot: scope.kind === "warehouse"
            ? warehouseCodes.get(scope.warehouseId) ?? null
            : null,
          productVariantId: variant.id,
          productVariantSkuSnapshot: variant.sku,
          productVariantNameSnapshot: variant.name,
          legacyAtpUnits: legacyAtp.toString(),
          proposedAtpUnits: proposedAtp.toString(),
          differenceUnits: (proposedAtp - legacyAtp).toString(),
          readinessState: proposedProjection.status,
          classifications: classifyShadowDifference(
            snapshot,
            projectionRequest,
            legacyAtp,
            proposedProjection,
          ),
          proposedProjection,
        });
      }
    }
    const completedAt = this.clock.now();
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
      throw new InventoryAvailabilityShadowServiceError(
        500,
        "INVENTORY_AVAILABILITY_INVALID_CLOCK",
        "The injected shadow-run clock returned an invalid time.",
      );
    }
    return plannerShadowRunSchema.parse(await this.store.persistShadowRun({
      snapshot,
      results,
      requestedBy: actor,
      idempotencyKey: request.idempotencyKey,
      completedAt,
    }));
  }

  async getLatestProductShadow(productIdInput: number): Promise<PlannerShadowRunDto> {
    const productId = parseProductId(productIdInput);
    const result = await this.store.getLatestShadowRun(productId);
    if (!result) {
      throw new InventoryAvailabilityShadowServiceError(
        404,
        "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND",
        "No shadow comparison has been recorded for this product.",
      );
    }
    return plannerShadowRunSchema.parse(result);
  }
}

function parseProductId(value: number): number {
  const parsed = positiveDatabaseIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityShadowServiceError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      "Invalid product identifier.",
      parsed.error.issues.map((issue) => issue.message),
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

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityShadowServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}
