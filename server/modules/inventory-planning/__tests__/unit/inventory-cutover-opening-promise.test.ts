import { describe, expect, it } from "vitest";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { planCutoverReconstruction, reconstructionEvidenceHash, reconstructionHash } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { openingVerification } from "../fixtures/inventory-cutover-opening-interface.fixture";
import { emptyBinPromiseEvidence, reconstructionEvidence, reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";

function verifyUnfilledPromises(evidence: CutoverReconstructionEvidence): OpeningVerification {
  return { ...openingVerification(), expectedEvidenceHash: reconstructionEvidenceHash(evidence),
    levels: structuredClone(evidence.levels), lots: structuredClone(evidence.lots),
    owners: evidence.items.map(item => ({ orderId: item.orderId, orderItemId: item.id,
      remainingQty: String(item.quantity - item.fulfilledQuantity), reservedQty: "0", pickedQty: "0", allocations: [] })) };
}

describe("verified opening preserves journal-proven unfilled promises", () => {
  it.each(["inventory_cutover_opening_v1", "inventory_cutover_opening_v2"] as const)("%s retains full demand and raw proof without treating the promise as held stock", contractVersion => {
    const evidence = emptyBinPromiseEvidence(), verification = verifyUnfilledPromises(evidence);
    verification.contractVersion = contractVersion;
    const original = structuredClone({ evidence, verification });
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result).toMatchObject({ ready: true, blockers: [] });
    expect(result.plan.legacyPromiseReleases).toEqual(planCutoverReconstruction(evidence).legacyPromiseReleases);
    expect(result.plan.orders[0].lines[0]).toMatchObject({ requestedQty: "6", reservedQty: "0", pickedQty: "0",
      freshDemandQty: "6", allocations: [] });
    const planned = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan, verification);
    expect(planned.freshReservationsByLevel).toEqual([{ inventoryLevelId: 20, reservedQty: "6" }]);
    expect(planned.orders[0].plan.lines[0]).toMatchObject({ requestedQty: "6", plannedQty: "6", shortfallQty: "0" });
    expect({ evidence, verification }).toEqual(original);
  });

  it.each(["0", "4"])("keeps an explicit shortfall when only %s units can be allocated", supply => {
    const evidence = emptyBinPromiseEvidence(supply);
    const result = evaluateCutoverOpening(evidence, verifyUnfilledPromises(evidence));
    expect(result.ready).toBe(true);
    const planned = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan);
    expect(planned.orders[0].plan.lines[0]).toMatchObject({ requestedQty: "6", plannedQty: supply,
      shortfallQty: (BigInt(6) - BigInt(supply)).toString() });
    expect(planned.orders[0].plan.status).toBe("partial");
  });

  it("does not allocate the same real stock to two promised orders", () => {
    const evidence = emptyBinPromiseEvidence("8");
    evidence.orders.push({ ...evidence.orders[0], id: 2 });
    evidence.items.push({ ...evidence.items[0], id: 12, orderId: 2, omsOrderLineId: "12" });
    evidence.journals.push({ ...evidence.journals[0], orderId: 2, orderItemId: 12, journalHash: "c".repeat(64) });
    evidence.levels[0].reservedQty = "12";
    const result = evaluateCutoverOpening(evidence, verifyUnfilledPromises(evidence));
    expect(result.ready).toBe(true);
    const planned = planFreshCutoverClaims(reconstructionSupply(evidence), result.plan);
    expect(planned.freshReservationsByLevel).toEqual([{ inventoryLevelId: 20, reservedQty: "8" }]);
    expect(planned.orders.map(order => order.plan.lines[0])).toMatchObject([
      { requestedQty: "6", plannedQty: "6", shortfallQty: "0" },
      { requestedQty: "6", plannedQty: "2", shortfallQty: "4" },
    ]);
  });

  it("can preserve unrelated unknown history without using it to authorize a release", () => {
    const evidence = emptyBinPromiseEvidence();
    evidence.journals.push({ ...evidence.journals[0], orderId: null, orderItemId: null,
      warehouseLocationId: 200, reservedQty: "0", unknownCount: "1" });
    const strict = planCutoverReconstruction(evidence);
    expect(strict.ready).toBe(false);
    expect(strict.legacyPromiseReleases).toHaveLength(1);
    const result = evaluateCutoverOpening(evidence, verifyUnfilledPromises(evidence));
    expect(result.ready).toBe(true);
    expect(result.plan.legacyPromiseReleases).toEqual(strict.legacyPromiseReleases);
    expect(result.historicalExceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "JOURNAL_CUSTODY_UNKNOWN" }),
    ]));
  });

  it("preserves another owner's picked custody and original costs at the promise position", () => {
    const evidence = emptyBinPromiseEvidence();
    evidence.items.push({ ...evidence.items[0], id: 12, omsOrderLineId: "12", quantity: 2, pickedQuantity: 2 });
    evidence.levels[0].pickedQty = "2";
    evidence.lots[0].pickedQty = "2";
    evidence.journals.push({ ...evidence.journals[0], orderItemId: 12, reservedQty: "0", pickedQty: "2" });
    evidence.costs = [{ ...reconstructionEvidence().costs[0], orderItemId: 12 }];
    const verification = verifyUnfilledPromises(evidence);
    verification.owners[1] = { ...verification.owners[1], pickedQty: "2", allocations: [{ inventoryLevelId: 10,
      lots: [{ inventoryLotId: 4, reservedQty: "0", pickedQty: "2", originalCostIds: [9] }] }] };
    const before = structuredClone({ evidence, verification });
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    expect(result.plan.legacyPromiseReleases[0]).toMatchObject({ pickedQty: "2", owners: [{ orderItemId: 11, reservedQty: "6" }] });
    expect(result.plan.orders[0].lines[1]).toMatchObject({ orderItemId: 12, requestedQty: "2", pickedQty: "2", freshDemandQty: "0" });
    expect(result.plan.orders[0].lines[1].allocations[0].lots[0].originalCosts).toEqual(evidence.costs);
    expect(planFreshCutoverClaims(reconstructionSupply(evidence), result.plan).freshReservationsByLevel)
      .toEqual([{ inventoryLevelId: 20, reservedQty: "6" }]);
    expect({ evidence, verification }).toEqual(before);
  });

  it.each<[string, (evidence: CutoverReconstructionEvidence) => void]>([
    ["unknown promise journal", e => { e.journals[0].unknownCount = "1"; }],
    ["ownerless unknown at the same position", e => { e.journals.push({ ...e.journals[0], orderId: null,
      orderItemId: null, reservedQty: "0", unknownCount: "1" }); }],
    ["incomplete owner total", e => { e.levels[0].reservedQty = "7"; }],
    ["mixed nonempty bin", e => { e.levels[0].variantQty = "1"; e.lots[0].onHandQty = "1"; }],
    ["real lot hold", e => { e.lots[0].reservedQty = "1"; }],
    ["independent build hold", e => { e.buildReservations.push(standaloneBuildReservation()); }],
    ["held order", e => { e.orders[0].onHold = 1; }],
    ["wrong warehouse", e => { e.orders[0].warehouseId = 2; }],
    ["picked progress", e => { e.items[0].pickedQuantity = 1; }],
    ["existing original cost", e => { e.costs = reconstructionEvidence().costs; }],
  ])("does not waive %s based on independent verification alone", (_name, mutate) => {
    const evidence = emptyBinPromiseEvidence(); mutate(evidence);
    const result = evaluateCutoverOpening(evidence, verifyUnfilledPromises(evidence));
    expect(result.ready).toBe(false);
    expect(result.plan.orders).toEqual([]);
    expect(result.plan.legacyPromiseReleases).toEqual([]);
  });

  it.each<[string, (verification: OpeningVerification) => void]>([
    ["changed demand", v => { v.owners[0].remainingQty = "5"; }],
    ["changed owner", v => { v.owners[0].orderId = 2; }],
    ["physical reservation", v => { v.owners[0].reservedQty = "1"; }],
    ["picked custody", v => { v.owners[0].pickedQty = "1"; }],
    ["empty allocation", v => { v.owners[0].allocations = [{ inventoryLevelId: 10, lots: [] }]; }],
  ])("requires explicit unfilled ownership instead of %s", (_name, mutate) => {
    const evidence = emptyBinPromiseEvidence(), verification = verifyUnfilledPromises(evidence); mutate(verification);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PROMISE_OWNER_MISMATCH" }));
    expect(result.plan.orders).toEqual([]);
    expect(result.plan.legacyPromiseReleases).toEqual([]);
  });

  it("requires verification of original recorded counters, not projected values", () => {
    const evidence = emptyBinPromiseEvidence(), verification = verifyUnfilledPromises(evidence);
    verification.levels[0].reservedQty = "0";
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "OPENING_LEVEL_VERIFICATION_MISMATCH" }));
    expect(result.plan.legacyPromiseReleases).toEqual([]);
  });

  it("clears all actions when an unrelated current receipt remains unresolved", () => {
    const evidence = emptyBinPromiseEvidence();
    evidence.shipmentReviewEvidence = [{ id: "receipt:1", kind: "channel_fulfillment_receipt", status: "pending", evidenceHash: "f".repeat(64) }];
    const result = evaluateCutoverOpening(evidence, verifyUnfilledPromises(evidence));
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "SHIPMENT_RECEIPT_REQUIRES_REVIEW" }));
    expect(result.plan.orders).toEqual([]);
    expect(result.plan.legacyPromiseReleases).toEqual([]);
  });

  it.each([
    ["0", "dab1d90d6c5305f836ecf133cbc0fc44c4bc8f16b40b26db0ec565faaa6b4326"],
    ["1", "f8f7645ae2fbb0ed1bd7f302bf8e8dc2cb550b489e42c61382d5297478c7bba9"],
  ])("keeps deployed successful v1 assessment bytes for unknown-count %s", (unknown, expectedHash) => {
    // Golden hashes captured from deployed ae98e28c/e36d97a8 before this change.
    // Immutable audit replay rebuilds assessments; existing success must not drift.
    const evidence = reconstructionEvidence(); evidence.journals[0].unknownCount = unknown;
    const verification = openingVerification(); verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result.ready).toBe(true);
    expect(reconstructionHash(result)).toBe(expectedHash);
  });
});
