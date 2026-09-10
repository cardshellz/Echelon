import { describe, expect, it } from "vitest";
import { openingVerificationSchema, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { deriveVerifiedOpeningPositions } from "@shared/types/inventory-opening-quantity-projection";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { projectVerifiedOpeningPositions } from "../../domain/inventory-opening-supply-projection";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { openingVerification } from "../fixtures/inventory-cutover-opening-interface.fixture";

function observation(): { evidence: ReturnType<typeof reconstructionEvidence>; verification: OpeningVerification } {
  const evidence = reconstructionEvidence();
  const verification = openingVerification();
  verification.contractVersion = "inventory_cutover_opening_v2";
  verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
  return { evidence, verification };
}

describe("lot-observed, single-authority opening", () => {
  it("does not require fixing two old counters before establishing one verified opening", () => {
    const { evidence, verification } = observation();
    evidence.levels[0].variantQty = "1"; evidence.levels[0].reservedQty = "10";
    evidence.lots[0].onHandQty = "17";
    verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    verification.lots[0].onHandQty = "25";
    const original = structuredClone({ evidence,verification });
    const result = evaluateCutoverOpening(evidence, verification);
    expect(result).toMatchObject({ ready: true, blockers: [], plan: { legacyPromiseReleases: [] } });
    expect(result.historicalExceptions.length).toBeGreaterThan(0);
    expect(openingVerificationSchema.parse(verification).levels[0]).toMatchObject({ variantQty: "25", reservedQty: "3", pickedQty: "2" });
    expect({ evidence,verification }).toEqual(original);
  });
  it("retains the previous immutable v1 semantics instead of reinterpreting saved approvals", () => {
    const { evidence, verification } = observation();
    verification.contractVersion = "inventory_cutover_opening_v1";
    verification.lots[0].onHandQty = "25";
    expect(evaluateCutoverOpening(evidence,verification).blockers).toContainEqual(expect.objectContaining({ code: "OPENING_LOT_VERIFICATION_MISMATCH" }));
  });
  it.each(["unitCostMills", "poUnitCostMills", "packagingUnitCostMills", "landedUnitCostMills"] as const)("cannot rewrite original %s", field => {
    const { evidence,verification } = observation(); verification.lots[0][field] = "1";
    expect(evaluateCutoverOpening(evidence,verification).blockers).toContainEqual(expect.objectContaining({ code: "OPENING_LOT_IDENTITY_OR_COST_CHANGED" }));
  });
  it("still requires exact current reserved/picked owners and original picked costs", () => {
    const { evidence,verification } = observation(); verification.lots[0].reservedQty = "4";
    expect(evaluateCutoverOpening(evidence,verification).blockers).toContainEqual(expect.objectContaining({ code: "OPENING_LOT_OWNERSHIP_INCOMPLETE" }));
    verification.lots[0].reservedQty = "3"; verification.owners[0].allocations[0].lots[0].originalCostIds = [];
    expect(evaluateCutoverOpening(evidence,verification).blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PICK_COST_MISMATCH" }));
  });
  it("does not erase unsupported packed custody by calculating a zero field", () => {
    const { evidence,verification } = observation(); evidence.levels[0].packedQty = "1";
    verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    expect(evaluateCutoverOpening(evidence,verification).blockers).toContainEqual(expect.objectContaining({ code: "OPENING_PACKED_CUSTODY_REQUIRES_REVIEW" }));
  });
  it("preserves exact cost integers beyond Number precision", () => {
    const { verification } = observation();
    const parsed = openingVerificationSchema.parse(verification);
    expect(parsed.lots[0].unitCostMills).toBe("9007199254740995");
  });
  it.each(["", "-1", "0.5", "NaN", "2147483648"])("rejects invalid lot observation %s", value => {
    const { verification } = observation(); verification.lots[0].onHandQty = value;
    expect(openingVerificationSchema.safeParse(verification).success).toBe(false);
  });
  it("does not turn a second position total into an authoritative physical observation", () => {
    const { verification } = observation(); verification.levels[0].variantQty = "99999";
    expect(openingVerificationSchema.parse(verification).levels[0].variantQty).toBe("20");
  });
  it("sums exact lot quantities and rejects aggregate overflow", () => {
    const { verification } = observation();
    verification.lots.push({ ...verification.lots[0], id: 5, onHandQty: "7", reservedQty: "0", pickedQty: "0" });
    expect(deriveVerifiedOpeningPositions(verification.levels,verification.lots)[0].variantQty).toBe("27");
    verification.lots[1].onHandQty = "2147483647";
    expect(() => deriveVerifiedOpeningPositions(verification.levels,verification.lots)).toThrow(/exceeds/);
  });
  it("retains explicit empty unlocated historical lots without inventing a bin", () => {
    const { evidence,verification } = observation();
    const lot = { ...evidence.lots[0], id: 5, warehouseLocationId: null, onHandQty: "0", reservedQty: "0", pickedQty: "0", status: "depleted" };
    evidence.lots.push(lot); verification.lots.push({ ...lot }); verification.expectedEvidenceHash = reconstructionEvidenceHash(evidence);
    expect(openingVerificationSchema.parse(verification).lots).toHaveLength(2);
    verification.lots[1].onHandQty = "1";
    expect(openingVerificationSchema.safeParse(verification).success).toBe(false);
  });
  it("projects the same verified quantities into ATP before any cutover writes", () => {
    const { verification } = observation(); verification.lots[0].onHandQty = "25";
    const recorded = [{ inventoryLevelId: 10, warehouseLocationId: 100, productVariantId: 101,
      variantQty: "1", reservedQty: "10", pickedQty: "2", packedQty: "0" }];
    expect(projectVerifiedOpeningPositions(recorded,verification)[0]).toMatchObject({ variantQty: "25", reservedQty: "3", pickedQty: "2" });
    expect(recorded[0].variantQty).toBe("1");
    expect(() => projectVerifiedOpeningPositions([{ ...recorded[0], warehouseLocationId: 101 }],verification)).toThrow(/exact inventory position/);
  });
});
