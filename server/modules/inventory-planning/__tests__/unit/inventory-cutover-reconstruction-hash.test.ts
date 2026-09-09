import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { cutoverReconstructionEvidenceSchema, type CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { planCutoverReconstruction, reconstructionEvidenceHash, reconstructionHash } from "../../domain/inventory-cutover-reconstruction";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";

/** Exact previous double-parse hash algorithm retained only as a compatibility oracle. */
function priorEvidenceHash(raw: CutoverReconstructionEvidence): string {
  const evidence = cutoverReconstructionEvidenceSchema.parse(raw);
  const sorted = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key,
    Array.isArray(value) ? value.map(row => ({ row, key: canonicalJson(row) }))
      .sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ row }) => row) : value]));
  return reconstructionHash(cutoverReconstructionEvidenceSchema.parse(sorted));
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

describe("reconstruction census memory optimization compatibility", () => {
  it("keeps the exact previous hash for unsorted and nested evidence without mutating any caller row", () => {
    const evidence = reconstructionEvidence();
    evidence.orders.push({ ...evidence.orders[0], id: 2, externalOrderId: "Order-é-🙂" });
    evidence.levels.push({ ...evidence.levels[0], id: 20, warehouseLocationId: 200, reservedQty: "0", pickedQty: "0" });
    evidence.lots.push({ ...evidence.lots[0], id: 5, warehouseLocationId: 200, reservedQty: "0", pickedQty: "0" });
    evidence.shipmentReviewEvidence.push({ id: "12", kind: "channel_fulfillment_receipt", status: "ignored", evidenceHash: "c".repeat(64) },
      { id: "2", kind: "channel_fulfillment_receipt", status: "ignored", evidenceHash: "d".repeat(64) });
    const expected = priorEvidenceHash(evidence); const before = canonicalJson(evidence);
    freezeDeep(evidence);
    expect(reconstructionEvidenceHash(evidence)).toBe(expected);
    expect(planCutoverReconstruction(evidence).evidenceHash).toBe(expected);
    expect(canonicalJson(evidence)).toBe(before);
    const reversed = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key,
      Array.isArray(value) ? [...value].reverse() : value])) as CutoverReconstructionEvidence;
    expect(reconstructionEvidenceHash(reversed)).toBe(expected);
    expect(planCutoverReconstruction(reversed).evidenceHash).toBe(expected);
  });

  it.each(["top", "row", "number"])("retains strict validation at the boundary for malformed %s evidence", kind => {
    const evidence = reconstructionEvidence();
    const malformed = kind === "top" ? { ...evidence, extra: true }
      : kind === "row" ? { ...evidence, levels: [{ ...evidence.levels[0], hiddenOverride: true }] }
      : { ...evidence, lots: [{ ...evidence.lots[0], unitCostMills: 9007199254740992 }] };
    expect(() => reconstructionEvidenceHash(malformed as CutoverReconstructionEvidence)).toThrow();
    expect(() => planCutoverReconstruction(malformed as CutoverReconstructionEvidence)).toThrow();
  });
});
