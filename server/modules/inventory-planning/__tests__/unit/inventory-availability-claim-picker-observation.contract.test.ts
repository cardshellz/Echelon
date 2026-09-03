import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalAvailabilityClaimPickCommandSchema,
  canonicalAvailabilityClaimPickResultSchema,
} from "@shared/types/inventory-availability-claims";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0648_inventory_availability_claim_picker_observation.sql"),
  "utf8",
);
const claimRepository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
  ),
  "utf8",
);
const inventoryRepository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts",
  ),
  "utf8",
);
const reviewRepository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/orders/canonical-claim-picker-observation-review.repository.ts",
  ),
  "utf8",
);

describe("canonical claim picker-observation contract", () => {
  it("requires explicit observation evidence that covers the pick", () => {
    const base = {
      claimId: "9",
      orderItemId: 71,
      warehouseLocationId: 3,
      quantity: "3",
      locationStrategy: "reconcile_picker_observation" as const,
      idempotencyKey: "pick:9:71:observation:1",
      actor: "picker-1",
      reason: "stock was physically present but absent from the system",
    };
    expect(canonicalAvailabilityClaimPickCommandSchema.safeParse({
      ...base,
      observation: {
        kind: "validated_item_scan",
        observedPhysicalQty: "3",
        locationCode: "P-3",
      },
    }).success).toBe(true);
    expect(canonicalAvailabilityClaimPickCommandSchema.safeParse({
      ...base,
      observation: {
        kind: "validated_item_scan",
        observedPhysicalQty: "2",
        locationCode: "P-3",
      },
    }).success).toBe(false);
    expect(canonicalAvailabilityClaimPickCommandSchema.safeParse({
      ...base,
      locationStrategy: "strict",
      observation: {
        kind: "validated_item_scan",
        observedPhysicalQty: "3",
        locationCode: "P-3",
      },
    }).success).toBe(false);
  });

  it("returns the exact recorded rebind, observed relocation, and review identity", () => {
    expect(canonicalAvailabilityClaimPickResultSchema.parse({
      outcome: "picked_with_observation",
      claimId: "9",
      claimLineId: "20",
      orderId: 70,
      orderItemId: 71,
      warehouseLocationIds: [3],
      quantity: "3",
      reconciledQuantity: "3",
      recordedReconciledQuantity: "1",
      observedRelocatedQuantity: "2",
      inventoryReviewId: 88,
      observationKind: "validated_item_scan",
      totalCostMills: "375",
      idempotentReplay: false,
    })).toEqual(expect.objectContaining({
      observedRelocatedQuantity: "2",
      inventoryReviewId: 88,
    }));
  });

  it("installs a distinct idempotent command without changing runtime authority or stock", () => {
    expect(migration).toContain("'pick_observation'");
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
  });

  it("keeps observation correction and review evidence inside the canonical transaction", () => {
    expect(claimRepository).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(claimRepository).toContain('code === "INVENTORY_LEVEL_CREATION_CONFLICT"');
    expect(claimRepository).toContain("reconcileObservedPickResource");
    expect(claimRepository).toContain("CLAIM_PICK_OBSERVATION_REVIEW_WRITER_MISSING");
    expect(claimRepository).toContain("observationReviewWriter.recordReview");
    expect(claimRepository).not.toContain("INSERT INTO wms.allocation_exceptions");
    expect(reviewRepository).toContain("INSERT INTO wms.allocation_exceptions");
    expect(claimRepository).toContain("\"pick_observation\" as const");
    expect(inventoryRepository).toContain("'availability_claim_observation'");
    expect(inventoryRepository).toContain("'reserve_move'");
    expect(inventoryRepository).toContain("ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING");
    expect(inventoryRepository).toContain("cost_provisional");
    expect(inventoryRepository).not.toContain("wms.allocation_exceptions");
  });
});
