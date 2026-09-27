import { describe, expect, it } from "vitest";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import { proposeRecordedBinOpening } from "../../../../../scripts/propose-inventory-cutover-bin-opening";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";

function source(): OpeningSource {
  const evidence = reconstructionEvidence();
  evidence.items[0].pickedQuantity = 0;
  return { contractVersion: "inventory_cutover_opening_source_v1", capturedAt: "2026-09-26T18:15:44.330Z",
    runtimeAuthority: "legacy", authorityRevision: "1", configurationRunId: null,
    evidenceHash: reconstructionEvidenceHash(evidence), evidence, labels: [], latestVerification: null };
}
function seal(input: OpeningSource): OpeningSource {
  return { ...input, evidenceHash: reconstructionEvidenceHash(input.evidence) };
}
describe("non-executable recorded-bin opening proposal", () => {
  it("preserves on-hand and every current obligation; historical holds are explicit proposed retirements", () => {
    const input = source(), before = structuredClone(input);
    const result = proposeRecordedBinOpening(input);
    expect(result.executable).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.candidate?.levels[0]).toMatchObject({ variantQty: "20", reservedQty: "0", pickedQty: "0" });
    expect(result.candidate?.owners).toEqual([{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "0", pickedQty: "0", allocations: [] }]);
    expect(result.assessment?.historicalExceptions.length).toBeGreaterThan(0);
    expect(result.levelChanges[0].before.pickedQty).toBe("2");
    expect(result.candidate?.verificationReference).toContain("not a physical count");
    expect(result.onHandValueDeltaMills).toBe("0");
    expect(input).toEqual(before);
  });
  it("proposes a bin-authoritative single-layer correction with exact integer cost", () => {
    const input = source(); input.evidence.levels[0].variantQty = "19";
    const result = proposeRecordedBinOpening(seal(input));
    expect(result.candidate?.lots[0].onHandQty).toBe("19");
    expect(result.onHandValueDeltaMills).toBe("-9007199254740995");
    expect(result.candidate?.lots[0].unitCostMills).toBe(input.evidence.lots[0].unitCostMills);
  });
  it("does not choose an arbitrary cost layer when multiple lots could explain the difference", () => {
    const input = source(); input.evidence.lots.push({ ...input.evidence.lots[0], id: 5 });
    const result = proposeRecordedBinOpening(seal(input));
    expect(result.candidate).toBeNull();
    expect(result.blockers[0].code).toBe("BIN_OPENING_COST_LAYER_AMBIGUOUS");
  });
  it.each(["picked", "fulfilled", "build", "packed", "canonical"])("stops bulk retirement for current %s evidence", kind => {
    const input = source();
    if (kind === "picked") input.evidence.items[0].pickedQuantity = 1;
    if (kind === "fulfilled") input.evidence.items[0].fulfilledQuantity = 1;
    if (kind === "build") input.evidence.buildReservations.push(standaloneBuildReservation());
    if (kind === "packed") input.evidence.levels[0].packedQty = "1";
    if (kind === "canonical") input.runtimeAuthority = "canonical";
    const result = proposeRecordedBinOpening(seal(input));
    expect(result.executable).toBe(false); expect(result.candidate).toBeNull(); expect(result.blockers.length).toBeGreaterThan(0);
  });
  it("keeps pending receipt work blocked instead of making a false ready opening", () => {
    const input = source(); input.evidence.shipmentReviewEvidence = [{ id: "12", kind: "channel_fulfillment_receipt", status: "review", evidenceHash: "a".repeat(64) }];
    const result = proposeRecordedBinOpening(seal(input));
    expect(result.assessment?.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "SHIPMENT_RECEIPT_REQUIRES_REVIEW" }));
    expect(result.assessment?.plan.orders).toEqual([]);
  });
  it("rejects stale input without proposing any baseline", () => {
    const input = source(); input.evidence.items[0].quantity++;
    expect(() => proposeRecordedBinOpening(input)).toThrow("Source evidence changed");
  });
});
