import { describe, expect, it } from "vitest";
import { planCutoverReconstruction, reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { sealClaimSupplySnapshot } from "../../domain/inventory-availability-planner";
import { reconstructionEvidence, reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

function ordinarySourceItem(): CutoverReconstructionEvidence["sourceItems"][number] {
  return { id:91, shipmentId:90, headerOrderId:1, orderItemId:11, replacementForOrderItemId:null,
    correctionForShipmentItemId:null, productVariantId:101, quantity:6, purpose:"customer_fulfillment",
    fromLocationId:100, shipmentStatus:"labeled", shipmentHeld:false };
}

describe("exact legacy cutover reconstruction", () => {
  it("adopts existing held/picked stock with original mills and separately identifies fresh demand", () => {
    const evidence = reconstructionEvidence(); const original = structuredClone(evidence);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.blockers).toEqual([]); expect(plan.ready).toBe(true);
    expect(plan.orders[0].lines[0]).toMatchObject({ requestedQty: "6", reservedQty: "3", pickedQty: "2", freshDemandQty: "1" });
    expect(plan.orders[0].lines[0].allocations[0].lots[0].originalCosts[0].totalCostMills).toBe("18014398509481990");
    expect(evidence).toEqual(original);
  });
  it("stable census hash ignores delivery order, changes for costs/identity/quantity", () => {
    const evidence = reconstructionEvidence(); evidence.levels.push({ ...evidence.levels[0], id: 12, warehouseLocationId: 200 });
    const hash = reconstructionEvidenceHash(evidence); evidence.levels.reverse(); expect(reconstructionEvidenceHash(evidence)).toBe(hash);
    evidence.costs[0].unitCostMills = "7"; expect(reconstructionEvidenceHash(evidence)).not.toBe(hash);
  });
  it.each(["planned", "queued", "labeled"])("accepts the owner customer_fulfillment purpose for %s intentions", (shipmentStatus) => {
    const evidence = reconstructionEvidence();
    evidence.sourceItems = [{ ...ordinarySourceItem(), shipmentStatus }];
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready:true, blockers:[] });
  });
  it.each(["ordered", "replacement", "concession", "omission_correction", "unclassified"])("does not adopt %s sources as ordinary customer demand", (purpose) => {
    const evidence = reconstructionEvidence();
    evidence.sourceItems = [{ ...ordinarySourceItem(), purpose }];
    expect(planCutoverReconstruction(evidence).blockers).toContainEqual(expect.objectContaining({
      code:"SHIPMENT_SOURCE_REQUIRES_REVIEW", subject:"source:91",
    }));
  });
  it("does not mistake a labeled source for clean authority when its orthogonal review flag is set", () => {
    const evidence = reconstructionEvidence();
    evidence.sourceItems = [ordinarySourceItem()];
    evidence.shipmentReviewEvidence = [{ id:"90", kind:"outbound_shipment_review", status:"labeled", evidenceHash:"f".repeat(64) }];
    expect(planCutoverReconstruction(evidence).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:"SHIPMENT_SOURCE_REQUIRES_REVIEW", subject:"source:91" }),
      expect.objectContaining({ code:"SHIPMENT_RECEIPT_REQUIRES_REVIEW", subject:"outbound_shipment_review:90" }),
    ]));
  });
  it("keeps the real physical review state blocked even for a captured terminal item with no remaining custody", () => {
    const evidence = reconstructionEvidence();
    evidence.orders.push({ ...evidence.orders[0], id:2, status:"shipped" });
    evidence.items.push({ ...evidence.items[0], id:12, orderId:2, quantity:1, pickedQuantity:1, fulfilledQuantity:1 });
    evidence.physicalItems = [{ id:"100", physicalShipmentId:"99", orderItemId:12, replacementForOrderItemId:null,
      legacySourceShipmentItemId:null, packageAllocationEntryId:null, productVariantId:101, sku:"P5",
      originalQuantity:1, adjustmentQuantity:0, effectiveQuantity:"1", purpose:"customer_fulfillment", packageStatus:"review" }];
    expect(planCutoverReconstruction(evidence).blockers).toContainEqual(expect.objectContaining({
      code:"PHYSICAL_SHIPMENT_REQUIRES_REVIEW", subject:"physical:100",
    }));
    evidence.physicalItems[0].packageStatus = "shipped";
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready:true, blockers:[] });
  });
  it("retains independent component reservations, without attributing them to order demand", () => {
    const evidence = reconstructionEvidence(); evidence.buildReservations.push({ ...standaloneBuildReservation(),buildOrderStatus:"released" });
    evidence.levels[0].reservedQty = "6"; evidence.lots[0].reservedQty = "6";
    const plan = planCutoverReconstruction(evidence); expect(plan.blockers).toEqual([]);
    expect(plan.retainedIndependentBuildReservationIds).toEqual([1]);
    expect(plan.orders[0].lines[0].allocations[0].lots[0].reservedQty).toBe("3");
  });
  it.each(["shipped", "cancelled"])("does not erase %s order residual custody", (status) => {
    const evidence = reconstructionEvidence(); evidence.orders[0].status = status;
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW");
  });
  it("blocks ambiguous multiple orders over multiple reserved lots", () => {
    const evidence = reconstructionEvidence(); evidence.items.push({ ...evidence.items[0], id: 12, quantity: 2, pickedQuantity: 0 });
    evidence.journals.push({ ...evidence.journals[0], orderItemId: 12, pickedQty: "0", reservedQty: "2" });
    evidence.lots.push({ ...evidence.lots[0], id: 5, reservedQty: "2", pickedQty: "0" }); evidence.levels[0].reservedQty = "5";
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("RESERVED_LOT_OWNERSHIP_AMBIGUOUS");
  });
  it.each(["reservedQty", "pickedQty"] as const)("blocks orphan %s instead of counting it as free supply", (field) => {
    const evidence = reconstructionEvidence(); evidence.journals.push({ ...evidence.journals[0], orderId: null, orderItemId: null,
      reservedQty: "0", pickedQty: "0", [field]: "1" });
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("ENCUMBRANCE_OWNER_UNRESOLVED");
  });
  it("requires original exact lot costs and never synthesizes from picked counter", () => {
    const evidence = reconstructionEvidence(); evidence.costs = [];
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("PICK_COST_CUSTODY_MISMATCH");
  });
  it("blocks accepted OMS demand lacking WMS coverage", () => {
    const evidence = reconstructionEvidence(); evidence.acceptedOmsDemand.push({ lineId: "99", orderId: "9", sku: "P5",
      productVariantId: 101, authorizedQty: "4", materializedQty: "0", authorizationStatus: "authorized" });
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("OMS_ACCEPTED_DEMAND_NOT_COVERED");
  });
  it.each(["ignored", "review", "requires_review", "pending"])("retains %s shipment receipt as an activation blocker", (status) => {
    const evidence = reconstructionEvidence(); evidence.shipmentReviewEvidence.push({ id: "9",kind: "channel_fulfillment_receipt",status,evidenceHash: "f".repeat(64) });
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("SHIPMENT_RECEIPT_REQUIRES_REVIEW");
  });
  it("fresh top-up does not reserve adopted resources again", () => {
    const evidence = reconstructionEvidence(); const plan = planCutoverReconstruction(evidence);
    const result = planFreshCutoverClaims(reconstructionSupply(evidence), plan);
    expect(result.freshReservationsByLevel).toEqual([{ inventoryLevelId: 10, reservedQty: "1" }]);
    expect(result.orders[0].plan.resourceClaims[0].claimedQty).toBe("6");
    expect(result.orders[0].freshPlan?.resourceClaims[0].claimedQty).toBe("1");
  });
  it("two orders share one cumulative planning balance with a true shortfall", () => {
    const evidence = reconstructionEvidence(); evidence.orders.push({ ...evidence.orders[0], id: 2 });
    evidence.items.push({ ...evidence.items[0], id: 12, orderId: 2, quantity: 30, pickedQuantity: 0 });
    const result = planFreshCutoverClaims(reconstructionSupply(evidence), planCutoverReconstruction(evidence));
    expect(result.orders[1].plan.lines[0]).toMatchObject({ plannedQty: "16", shortfallQty: "14" });
    expect(result.freshReservationsByLevel).toEqual([{ inventoryLevelId: 10, reservedQty: "17" }]);
    expect(result.inventoryPositions[0].reservedQty).toBe("20");
  });
  it("keeps ordinary short-pick demand but blocks refund-after-pick authority", () => {
    const evidence = reconstructionEvidence(); evidence.items[0].status = "short"; evidence.items[0].shortReason = "out_of_stock";
    expect(planCutoverReconstruction(evidence).ready).toBe(true);
    evidence.items[0].shortReason = "refund_after_pick";
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("REFUND_AFTER_PICK_CUSTODY_REQUIRES_REVIEW");
  });
  it("adopts fully picked completed lines as custody, not cancelled demand", () => {
    const evidence = reconstructionEvidence(); evidence.items[0].quantity=2; evidence.items[0].status="completed";
    evidence.journals[0].reservedQty="0"; evidence.levels[0].reservedQty="0"; evidence.lots[0].reservedQty="0";
    const plan=planCutoverReconstruction(evidence); expect(plan.ready).toBe(true);
    expect(plan.orders[0].lines[0].freshDemandQty).toBe("0");
  });
  it("preview and promoted active definitions produce the same reviewed demand impact", () => {
    const evidence=reconstructionEvidence(); const plan=planCutoverReconstruction(evidence);
    const active=reconstructionSupply(evidence); const draft=reconstructionSupply(evidence);
    draft.transformationModels[0].lifecycleSelection="draft_head"; draft.transformationModels[0].lifecycleStatus="draft";
    draft.safetyPolicies[0].lifecycleSelection="draft_head";
    const { snapshotFingerprint: _hash,...content }=draft;
    expect(planFreshCutoverClaims(sealClaimSupplySnapshot(content),plan).impactHash).toBe(planFreshCutoverClaims(active,plan).impactHash);
  });
});
