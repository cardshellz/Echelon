import { describe, expect, it } from "vitest";
import { assertCanonicalClaimDispatchSourceIdentity, canonicalClaimDispatchSourceKey, canonicalClaimDispatchSourceRequestSchema,
  selectCanonicalClaimDispatchPickedOwner } from "../../domain/inventory-availability-dispatch-source-command";
import { dispatchPlan } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";

function fixture() {
  const { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason } = dispatchPlan().command;
  const request = { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason };
  const source = { ...request, warehouseId: 1, warehouseLocationId: 50 as number | null, physicalShipmentId: null,
    physicalShipmentItemId: null, physicalShipmentItemQuantity: null, readiness: "authorized" as const, orderStatus: "ready_to_ship" };
  const evidence = {
    claims: [{ id: "10", orderId: 70, status: "active" }],
    lines: [{ id: "20", claimId: "10", orderItemId: 71, targetVariantId: 105, pickedQty: "5" }],
    resources: [{ id: "30", claimId: "10", claimLineId: "20", warehouseId: 1, warehouseLocationId: 50, sourceVariantId: 105, pickedQty: "5" }],
    lots: [{ id: "40", claimId: "10", claimResourceId: "30", pickedQty: "5" }],
    picks: [{ id: "50", claimId: "10", claimLineId: "20", claimResourceId: "30", claimLotAllocationId: "40",
      quantity: "7", reversedQuantity: "1", dispatchedQuantity: "1" }],
  };
  const run = () => selectCanonicalClaimDispatchPickedOwner(request, source, evidence);
  return { request, source, evidence, run };
}

describe("exact canonical dispatch source command", () => {
  it("derives the replay key only from validated source identity", () => {
    expect(canonicalClaimDispatchSourceKey(101)).toBe("canonical-dispatch:source:101:v1");
    for (const value of [0, -1, 1.2, Number.NaN, Number.MAX_SAFE_INTEGER]) expect(() => canonicalClaimDispatchSourceKey(value)).toThrow();
  });
  it("permits retry actor/reason changes but verifies each immutable business field", () => {
    const f = fixture(); const command = dispatchPlan().command;
    expect(() => assertCanonicalClaimDispatchSourceIdentity({ ...f.request, actor: "retry-worker", reason: "Retry" }, command)).not.toThrow();
    for (const key of ["orderId", "orderItemId", "outboundShipmentId", "sourceShipmentItemId", "productVariantId", "quantity"] as const) {
      expect(() => assertCanonicalClaimDispatchSourceIdentity({ ...f.request, [key]: key === "quantity" ? "4" : 999 }, command))
        .toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT" }));
    }
  });
  it.each(["0", "-1", "1.5", "NaN", "01", "9223372036854775808"])("rejects invalid quantity %s at ingress", (quantity) => {
    expect(canonicalClaimDispatchSourceRequestSchema.safeParse({ ...fixture().request, quantity }).success).toBe(false);
  });
  it("refuses client claim/bin/physical authorization fields", () => {
    expect(canonicalClaimDispatchSourceRequestSchema.safeParse({ ...fixture().request, claimId: "10" }).success).toBe(false);
  });
  it("reconciles pick minus unpick minus dispatch and does not mutate inputs", () => {
    const f = fixture(); const before = structuredClone({ request: f.request, source: f.source, evidence: f.evidence });
    expect(f.run()).toEqual({ claimId: "10", warehouseId: 1, warehouseLocationId: 50 });
    expect({ request: f.request, source: f.source, evidence: f.evidence }).toEqual(before);
  });
  it("permits the sole proved bin when source bin is NULL", () => {
    const f = fixture(); f.source.warehouseLocationId = null; expect(f.run().warehouseLocationId).toBe(50);
  });
  it.each(["claims", "lines", "resources", "lots", "picks"] as const)("rejects duplicate %s evidence", (kind) => {
    const f = fixture(); (f.evidence[kind] as unknown[]).push(structuredClone(f.evidence[kind][0]));
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID" }));
  });
  it.each(["lines", "resources", "lots"] as const)("rejects stale %s picked counters", (kind) => {
    const f = fixture(); f.evidence[kind][0].pickedQty = "6";
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID" }));
  });
  it("rejects overspent original picks", () => {
    const f = fixture(); f.evidence.picks[0].reversedQuantity = "7";
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_LINEAGE_INVALID" }));
  });
  it("does not treat a fully unpicked historic bin as current picked custody", () => {
    const f = fixture(); f.evidence.picks[0].reversedQuantity = "6";
    f.evidence.lines[0].pickedQty = f.evidence.resources[0].pickedQty = f.evidence.lots[0].pickedQty = "0";
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_PICKED_MISSING" }));
  });
  it("rejects repick in another bin while preserving the historical source bin", () => {
    const f = fixture(); f.evidence.resources[0].warehouseLocationId = 51;
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_BIN_MISMATCH" }));
    expect(f.source.warehouseLocationId).toBe(50);
  });
  it("does not use source bin or quantity to choose among two independently picked claims", () => {
    const f = fixture();
    f.evidence.claims.push({ id: "11", orderId: 70, status: "active" });
    f.evidence.lines.push({ ...f.evidence.lines[0], id: "21", claimId: "11", pickedQty: "1" });
    f.evidence.resources.push({ ...f.evidence.resources[0], id: "31", claimId: "11", claimLineId: "21", warehouseLocationId: 51, pickedQty: "1" });
    f.evidence.lots.push({ id: "41", claimId: "11", claimResourceId: "31", pickedQty: "1" });
    f.evidence.picks.push({ id: "51", claimId: "11", claimLineId: "21", claimResourceId: "31", claimLotAllocationId: "41",
      quantity: "1", reversedQuantity: "0", dispatchedQuantity: "0" });
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_PICKED_AMBIGUOUS" }));
  });
  it("does not choose one of two bins owned by the same picked claim", () => {
    const f = fixture(); f.evidence.lines[0].pickedQty = "6";
    f.evidence.resources.push({ ...f.evidence.resources[0], id: "31", warehouseLocationId: 51, pickedQty: "1" });
    f.evidence.lots.push({ id: "41", claimId: "10", claimResourceId: "31", pickedQty: "1" });
    f.evidence.picks.push({ ...f.evidence.picks[0], id: "51", claimResourceId: "31", claimLotAllocationId: "41",
      quantity: "1", reversedQuantity: "0", dispatchedQuantity: "0" });
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_PICKED_AMBIGUOUS" }));
  });
  it("rejects exact-owner quantity shortfall and a different warehouse", () => {
    const f = fixture(); f.request.quantity = f.source.quantity = "6";
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_PICKED_SHORTFALL" }));
    f.request.quantity = f.source.quantity = "5"; f.source.warehouseId = 2;
    expect(f.run).toThrow(expect.objectContaining({ code: "CLAIM_DISPATCH_SOURCE_WAREHOUSE_MISMATCH" }));
  });
});
