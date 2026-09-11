import { describe, expect, it } from "vitest";
import { planCutoverReconstruction, reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims, projectCutoverPromiseReservations } from "../../domain/inventory-cutover-reconstruction-planning";
import { sealClaimSupplySnapshot } from "../../domain/inventory-availability-planner";
import { emptyBinPromiseEvidence, reconstructionEvidence, reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { cutoverReconstructionEvidenceSchema } from "@shared/types/inventory-cutover-reconstruction";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createHash } from "node:crypto";

function ordinarySourceItem(): CutoverReconstructionEvidence["sourceItems"][number] {
  return { id:91, shipmentId:90, headerOrderId:1, orderItemId:11, replacementForOrderItemId:null,
    correctionForShipmentItemId:null, productVariantId:101, quantity:6, purpose:"customer_fulfillment",
    fromLocationId:100, shipmentStatus:"labeled", shipmentHeld:false };
}

describe("exact legacy cutover reconstruction", () => {
  it("streamed collection hashing preserves prior immutable evidence bytes", () => {
    const raw = reconstructionEvidence();
    const parsed = cutoverReconstructionEvidenceSchema.parse(raw);
    const sorted = Object.fromEntries(Object.entries(parsed).map(([key,value])=>[key,Array.isArray(value)
      ? value.map(row=>({row,key:canonicalJson(row)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(entry=>entry.row):value]));
    const prior = createHash("sha256").update(canonicalJson(sorted)).digest("hex");
    expect(reconstructionEvidenceHash(raw)).toBe(prior);
    expect(raw).toEqual(reconstructionEvidence());
  });
  it("groups acknowledgment evidence without clearing inventory or original-cost review", () => {
    const evidence = reconstructionEvidence();
    evidence.shipmentReviewEvidence.push({ id: "package:7", kind: "channel_fulfillment_acknowledgment", status: "ignored", evidenceHash: "f".repeat(64) });
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready: false, blockers: [expect.objectContaining({
      code: "SHIPMENT_ACKNOWLEDGMENT_REQUIRES_INVENTORY_RECONCILIATION" })] });
  });
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
  it.each(["shipped", "completed", "cancelled"])("keeps physical review blocked for a %s item without remaining custody", (status) => {
    const evidence = reconstructionEvidence();
    evidence.orders.push({ ...evidence.orders[0], id:2, status });
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
  it.each(["shipped", "completed", "cancelled"])("does not erase %s order residual custody", (status) => {
    const evidence = reconstructionEvidence(); evidence.orders[0].status = status;
    expect(planCutoverReconstruction(evidence).blockers.map((row) => row.code)).toContain("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW");
  });
  it("does not recreate pending historical lines under a completed order with no warehouse", () => {
    const evidence = reconstructionEvidence();
    evidence.orders.push({ ...evidence.orders[0], id: 2, warehouseId: null, status: "completed" });
    evidence.items.push({ ...evidence.items[0], id: 12, orderId: 2, pickedQuantity: 0, status: "pending" });
    const plan = planCutoverReconstruction(evidence);
    expect(plan).toMatchObject({ ready: true, blockers: [] });
    expect(plan.orders.map((order) => order.orderId)).toEqual([1]);
    expect(plan.legacyPromiseReleases).toEqual([]);
  });
  it.each(["reservedQty", "pickedQty"] as const)("retains negative %s on completed orders for review", (field) => {
    const evidence = reconstructionEvidence(); evidence.orders[0].status = "completed";
    Object.assign(evidence.journals[0], { reservedQty: "0", pickedQty: "0", [field]: "-1" });
    const plan = planCutoverReconstruction(evidence);
    expect(plan.orders).toEqual([]);
    expect(plan.legacyPromiseReleases).toEqual([]);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW" }),
      expect.objectContaining({ code: "ENCUMBRANCE_OWNER_UNRESOLVED" }),
    ]));
  });
  it.each([null, "invented", "COMPLETED"])("never adopts custody or creates fresh demand for unknown state %s", (status) => {
    const evidence = reconstructionEvidence(); evidence.orders[0].status = status;
    const plan = planCutoverReconstruction(evidence);
    expect(plan.orders).toEqual([]);
    expect(plan.legacyPromiseReleases).toEqual([]);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ORDER_STATE_REQUIRES_REVIEW" }),
      expect.objectContaining({ code: "ENCUMBRANCE_OWNER_UNRESOLVED" }),
    ]));
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

describe("bounded empty-bin promise handoff", () => {
  it("does not reseal tampered original supply evidence into an apparently valid handoff", () => {
    const evidence = emptyBinPromiseEvidence(); const plan = planCutoverReconstruction(evidence);
    const snapshot = reconstructionSupply(evidence);
    snapshot.inventoryPositions[1].variantQty = "200";
    expect(() => planFreshCutoverClaims(snapshot, plan)).toThrow("content does not match its fingerprint");
  });
  it("preserves demand and plans exact stock elsewhere without mutating the raw census", () => {
    const evidence = emptyBinPromiseEvidence(); const original = structuredClone(evidence);
    const plan = planCutoverReconstruction(evidence);
    expect(plan).toMatchObject({ ready: true, blockers: [], legacyPromiseReleases: [{ inventoryLevelId: 10, reservedQty: "6",
      owners: [{ orderId: 1, orderItemId: 11, reservedQty: "6", journalCount: "1", journalHash: "b".repeat(64) }] }] });
    expect(plan.orders[0].lines[0]).toMatchObject({ requestedQty: "6", reservedQty: "0", freshDemandQty: "6", allocations: [] });
    const planned = planFreshCutoverClaims(reconstructionSupply(evidence), plan);
    expect(planned.orders[0].plan.lines[0]).toMatchObject({ requestedQty: "6", plannedQty: "6", shortfallQty: "0" });
    expect(planned.freshReservationsByLevel).toEqual([{ inventoryLevelId: 20, reservedQty: "6" }]);
    expect(planned.inventoryPositions.map((position) => position.reservedQty)).toEqual(["0", "6"]);
    expect(evidence).toEqual(original);
  });
  it("plans the full batch against shared capacity and preserves an explicit shortfall", () => {
    const evidence = emptyBinPromiseEvidence("8");
    evidence.orders.push({ ...evidence.orders[0], id: 2 });
    evidence.items.push({ ...evidence.items[0], id: 12, orderId: 2, omsOrderLineId: "12" });
    evidence.journals.push({ ...evidence.journals[0], orderId: 2, orderItemId: 12, journalHash: "c".repeat(64) });
    evidence.levels[0].reservedQty = "12";
    const result = planFreshCutoverClaims(reconstructionSupply(evidence), planCutoverReconstruction(evidence));
    expect(result.orders.map((row) => row.plan.lines[0])).toMatchObject([
      { requestedQty: "6", plannedQty: "6", shortfallQty: "0" }, { requestedQty: "6", plannedQty: "2", shortfallQty: "4" },
    ]);
    expect(result.freshReservationsByLevel).toEqual([{ inventoryLevelId: 20, reservedQty: "8" }]);
  });
  it("does not treat ineligible other-bin stock as usable supply", () => {
    const evidence = emptyBinPromiseEvidence(); const snapshot = reconstructionSupply(evidence);
    snapshot.locations[1].isFrozen = true;
    const { snapshotFingerprint: _old, ...content } = snapshot;
    const result = planFreshCutoverClaims(sealClaimSupplySnapshot(content), planCutoverReconstruction(evidence));
    expect(result.orders[0].plan.lines[0]).toMatchObject({ requestedQty: "6", plannedQty: "0", shortfallQty: "6" });
    expect(result.freshReservationsByLevel).toEqual([]);
  });
  it.each<[string, (evidence: CutoverReconstructionEvidence) => void]>([
    ["unknown current owner", (e) => { e.journals[0].unknownCount = "1"; }],
    ["ownerless zero-net unknown", (e) => { e.journals.push({ ...e.journals[0], orderId: null, orderItemId: null, reservedQty: "0", unknownCount: "1" }); }],
    ["other-owner residual", (e) => { e.journals.push({ ...e.journals[0], orderId: null, orderItemId: null, reservedQty: "1" }); }],
    ["counter below owner total", (e) => { e.levels[0].reservedQty = "5"; }],
    ["counter above owner total", (e) => { e.levels[0].reservedQty = "7"; }],
    ["partially backed lot", (e) => { e.lots[0].reservedQty = "1"; }],
    ["nonempty physical position", (e) => { e.levels[0].variantQty = "1"; e.lots[0].onHandQty = "1"; }],
    ["independent build hold", (e) => { e.buildReservations.push(standaloneBuildReservation()); }],
    ["cancelled order", (e) => { e.orders[0].status = "cancelled"; }],
    ["held order", (e) => { e.orders[0].onHold = 1; }],
    ["held item", (e) => { e.items[0].onHold = true; }],
    ["picked progress", (e) => { e.items[0].pickedQuantity = 1; }],
    ["fulfilled progress", (e) => { e.items[0].fulfilledQuantity = 1; }],
    ["shipped journal", (e) => { e.journals[0].shippedQty = "1"; }],
    ["wrong warehouse", (e) => { e.orders[0].warehouseId = 2; }],
    ["wrong variant", (e) => { e.journals[0].productVariantId = 102; }],
    ["existing outbound intention", (e) => { e.sourceItems.push(ordinarySourceItem()); }],
    ["existing physical allocation", (e) => { e.physicalItems.push({ id: "100", physicalShipmentId: "99", orderItemId: 11,
      replacementForOrderItemId: null, legacySourceShipmentItemId: null, packageAllocationEntryId: "300", productVariantId: 101, sku: "P5",
      originalQuantity: 6, adjustmentQuantity: 0, effectiveQuantity: "6", purpose: "customer_fulfillment", packageStatus: "shipped" }); }],
    ["original cost evidence", (e) => { e.costs = reconstructionEvidence().costs; }],
    ["duplicate owner group", (e) => { e.journals.push({ ...e.journals[0] }); }],
  ])("keeps %s outside the automatic handoff", (_name, mutate) => {
    const evidence = emptyBinPromiseEvidence(); mutate(evidence);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.legacyPromiseReleases).toEqual([]); expect(plan.ready).toBe(false);
  });
  it("does not discard an unrelated unknown journal to make the batch ready", () => {
    const evidence = emptyBinPromiseEvidence();
    evidence.journals.push({ ...evidence.journals[0], warehouseLocationId: 200, orderId: null, orderItemId: null, reservedQty: "0", unknownCount: "1" });
    const plan = planCutoverReconstruction(evidence);
    expect(plan.legacyPromiseReleases).toHaveLength(1);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("JOURNAL_CUSTODY_UNKNOWN");
    expect(() => planFreshCutoverClaims(reconstructionSupply(evidence), plan)).toThrow("CUTOVER_RECONSTRUCTION_BLOCKED");
  });
  it.each([3, 5])("does not hand off terminal shipped custody missing original costs for %i units", (quantity) => {
    const evidence = emptyBinPromiseEvidence();
    evidence.orders[0].status = "shipped";
    Object.assign(evidence.items[0], { quantity, pickedQuantity: quantity, fulfilledQuantity: quantity, status: "completed" });
    evidence.levels[0].reservedQty = String(quantity); evidence.journals[0].reservedQty = String(quantity);
    evidence.physicalItems.push({ id: "100", physicalShipmentId: "99", orderItemId: 11,
      replacementForOrderItemId: null, legacySourceShipmentItemId: null, packageAllocationEntryId: "300", productVariantId: 101, sku: "P5",
      originalQuantity: quantity, adjustmentQuantity: 0, effectiveQuantity: String(quantity), purpose: "customer_fulfillment", packageStatus: "shipped" });
    evidence.sourceItems.push({ ...ordinarySourceItem(), quantity, shipmentStatus: quantity === 3 ? "shipped" : "queued" });
    evidence.shipmentReviewEvidence.push({ id: "package:99", kind: "channel_fulfillment_acknowledgment", status: "ignored", evidenceHash: "f".repeat(64) });
    const plan = planCutoverReconstruction(evidence);
    expect(plan.ready).toBe(false); expect(plan.legacyPromiseReleases).toEqual([]);
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW", "SHIPMENT_ACKNOWLEDGMENT_REQUIRES_INVENTORY_RECONCILIATION",
    ]));
  });
  it("binds projection to every exact before-counter and keeps the per-product projection scoped", () => {
    const evidence = emptyBinPromiseEvidence(); const plan = planCutoverReconstruction(evidence);
    const snapshot = reconstructionSupply(evidence);
    expect(projectCutoverPromiseReservations([snapshot.inventoryPositions[1]], plan.legacyPromiseReleases))
      .toEqual([snapshot.inventoryPositions[1]]);
    snapshot.inventoryPositions[0].reservedQty = "5";
    expect(() => projectCutoverPromiseReservations(snapshot.inventoryPositions, plan.legacyPromiseReleases))
      .toThrow("reviewed legacy promise position changed");
    const incomplete = reconstructionSupply(evidence); incomplete.inventoryPositions.shift();
    const { snapshotFingerprint: _old, ...content } = incomplete;
    expect(() => planFreshCutoverClaims(sealClaimSupplySnapshot(content), plan)).toThrow("every reviewed promise position");
  });
});
