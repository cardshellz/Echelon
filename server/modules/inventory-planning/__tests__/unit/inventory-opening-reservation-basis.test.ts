import { describe, expect, it } from "vitest";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { cutoverReconstructionReceiptSchema } from "@shared/types/inventory-cutover-reconstruction";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims, projectCutoverPromiseReservations } from "../../domain/inventory-cutover-reconstruction-planning";
import { reconstructionEvidence, reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";

function fixture() {
  const evidence = reconstructionEvidence();
  evidence.levels[0].reservedQty = "69";
  evidence.journals[0].unknownCount = "1";
  const verification: OpeningVerification = { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: reconstructionEvidenceHash(evidence),
    expectedAuthorityRevision: "1", expectedConfigurationRunId: null, verificationReference: "independent count and complete current custody",
    verificationEvidenceHash: "a".repeat(64), verifiedAt: "2026-09-10T12:00:00Z", historicalDisposition: "preserve_unresolved",
    reservationBasis: "verified_current_lot_custody", levels: structuredClone(evidence.levels), lots: structuredClone(evidence.lots),
    owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
      allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
  return { evidence, verification };
}

describe("explicit independently verified reservation basis", () => {
  it("uses v2 lot-derived positions without subtracting the raw counter twice", () => {
    const { evidence, verification } = fixture(); verification.contractVersion = "inventory_cutover_opening_v2";
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    expect(result.plan.openingReservationRebases?.[0]).toMatchObject({ reservedQty: "69", physicalReservedQty: "3" });
    const fresh = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan, verification);
    expect(fresh.inventoryPositions[0]).toMatchObject({ variantQty: "20", reservedQty: "4", pickedQty: "2" });
  });
  it("cannot combine a reservation-only v2 handoff with a different physical lot observation", () => {
    const { evidence, verification } = fixture(); verification.contractVersion = "inventory_cutover_opening_v2";
    verification.lots[0].onHandQty = "25";
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(false); expect(result.plan.openingReservationRebases).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_LOT_VERIFICATION_MISMATCH" }));
  });
  it("retains independent build holds without making their stock available to customers", () => {
    const { evidence, verification } = fixture();
    evidence.buildReservations.push({ ...standaloneBuildReservation(), buildOrderStatus: "released" });
    evidence.lots[0].reservedQty = "6";
    verification.lots = structuredClone(evidence.lots); verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    expect(result.plan.retainedIndependentBuildReservationIds).toEqual([evidence.buildReservations[0].reservationId]);
    expect(result.plan.openingReservationRebases?.[0].physicalReservedQty).toBe("6");
    expect(planFreshCutoverClaims(reconstructionSupply(evidence), result.plan).inventoryPositions[0].reservedQty).toBe("7");
  });
  it("keeps a reviewed counter translation when no current order remains", () => {
    const { evidence, verification } = fixture();
    evidence.orders = []; evidence.items = []; evidence.costs = [];
    evidence.levels[0].pickedQty = "0"; evidence.lots[0].pickedQty = "0"; evidence.lots[0].reservedQty = "0";
    verification.owners = []; verification.levels = structuredClone(evidence.levels); verification.lots = structuredClone(evidence.lots);
    verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true); expect(result.plan.orders).toEqual([]);
    expect(result.plan.openingReservationRebases).toHaveLength(1);
    const fresh = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan);
    expect(fresh.inventoryPositions[0]).toMatchObject({ variantQty: "20", reservedQty: "0", pickedQty: "0" });
  });
  it("translates a mixed bin without guessing historical ownership or changing stock", () => {
    const { evidence, verification } = fixture(), before = structuredClone({ evidence, verification });
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    expect(result.plan.legacyPromiseReleases).toEqual([]);
    expect(result.plan.openingReservationRebases).toEqual([{ inventoryLevelId: 10, warehouseId: 1, warehouseLocationId: 100,
      productVariantId: 101, variantQty: "20", reservedQty: "69", physicalReservedQty: "3", pickedQty: "2", packedQty: "0" }]);
    expect(result.plan.orders[0].lines[0]).toMatchObject({ requestedQty: "6", reservedQty: "3", pickedQty: "2", freshDemandQty: "1" });
    expect(result.historicalExceptions.map(row => row.code)).toContain("JOURNAL_CUSTODY_UNKNOWN");
    expect({ evidence, verification }).toEqual(before);
    const fresh = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan);
    expect(fresh.freshReservationsByLevel).toEqual([{ inventoryLevelId: 10, reservedQty: "1" }]);
    expect(fresh.inventoryPositions[0]).toMatchObject({ variantQty: "20", reservedQty: "4", pickedQty: "2" });
  });
  it("does not change old verification policy without opt-in", () => {
    const { evidence, verification } = fixture(); delete verification.reservationBasis;
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(false); expect(result.plan.openingReservationRebases).toBeUndefined();
  });
  it("retains all demand and explicit shortage when the bin has no unreserved stock", () => {
    const { evidence, verification } = fixture();
    evidence.levels[0].variantQty = "3"; evidence.lots[0].onHandQty = "3";
    verification.levels = structuredClone(evidence.levels); verification.lots = structuredClone(evidence.lots);
    verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    const fresh = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan);
    expect(fresh.orders[0].plan.lines[0]).toMatchObject({ requestedQty: "6", plannedQty: "5", shortfallQty: "1" });
  });
  it.each(["stock", "picked", "packed", "lot_reserved", "negative_lot", "warehouse"])("blocks an invalid physical basis: %s", kind => {
    const { evidence, verification } = fixture();
    if (kind === "stock") evidence.lots[0].onHandQty = "19";
    if (kind === "picked") evidence.lots[0].pickedQty = "1";
    if (kind === "packed") evidence.levels[0].packedQty = "1";
    if (kind === "lot_reserved") evidence.levels[0].reservedQty = "2";
    if (kind === "negative_lot") evidence.lots[0].reservedQty = "-1";
    if (kind === "warehouse") evidence.levels[0].warehouseId = null;
    verification.levels = structuredClone(evidence.levels); verification.lots = structuredClone(evidence.lots);
    verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(false); expect(result.plan.orders).toEqual([]); expect(result.plan.openingReservationRebases).toBeUndefined();
  });
  it.each(["owners", "costs", "stale", "receipt"])("keeps complete proof requirements: %s", kind => {
    const { evidence, verification } = fixture();
    if (kind === "owners") verification.owners = [];
    if (kind === "costs") verification.owners[0].allocations[0].lots[0].originalCostIds = [];
    if (kind === "stale") verification.expectedEvidenceHash = "0".repeat(64);
    if (kind === "receipt") { evidence.shipmentReviewEvidence.push({ id: "1", kind: "channel_fulfillment_receipt", status: "review", evidenceHash: "f".repeat(64) }); verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence); }
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(false); expect(result.plan.orders).toEqual([]); expect(result.plan.openingReservationRebases).toBeUndefined();
  });
  it("rejects a changed counter before fresh allocation or publication projection", () => {
    const { evidence, verification } = fixture(); const result = evaluateCutoverOpening(evidence, verification);
    const positions = reconstructionSupply(evidence).inventoryPositions; positions[0].reservedQty = "68";
    expect(() => projectCutoverPromiseReservations(positions, [], result.plan.openingReservationRebases)).toThrow("changed");
  });
  it("does not permit an unaudited counter translation in a receipt", () => {
    const { evidence, verification } = fixture(); const plan = evaluateCutoverOpening(evidence, verification).plan;
    const raw = { evidenceHash: plan.evidenceHash, claimIds: ["1"], orderIds: [1], retainedIndependentBuildReservationIds: [],
      openingBalance: { ...plan.openingBalance!, snapshotId: "1" }, openingReservationRebases: plan.openingReservationRebases };
    expect(cutoverReconstructionReceiptSchema.safeParse(raw).success).toBe(false);
    expect(cutoverReconstructionReceiptSchema.safeParse({ ...raw, openingReservationRebaseTransactionIds: [5] }).success).toBe(true);
  });
});
