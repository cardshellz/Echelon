import { describe, expect, it } from "vitest";
import { openingVerificationSchema, requiredOpeningItems, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { planCutoverReconstruction, reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { reconstructionEvidence, reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { standaloneBuildReservation } from "../fixtures/inventory-cutover-preflight.fixture";

function verification(evidence: CutoverReconstructionEvidence): OpeningVerification {
  return { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: reconstructionEvidenceHash(evidence),
    expectedAuthorityRevision: "1", expectedConfigurationRunId: null, verificationReference: "Warehouse count and current pick-owner check / COUNT-42",
    verificationEvidenceHash: "e".repeat(64), verifiedAt: "2026-09-09T12:00:00.000Z", historicalDisposition: "preserve_unresolved",
    levels: structuredClone(evidence.levels), lots: structuredClone(evidence.lots), owners: [{
      orderId: 1, orderItemId: 11, remainingQty: String(evidence.items[0].quantity-evidence.items[0].fulfilledQuantity),
      reservedQty: "3", pickedQty: "2", allocations: [{ inventoryLevelId: 10,
        lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
}
function codes(evidence: CutoverReconstructionEvidence, input = verification(evidence)) {
  return evaluateCutoverOpening(evidence,input).blockers.map(row => row.code);
}

describe("independently verified current inventory opening", () => {
  it("preserves stock and original exact mills while creating a distinct opening proof", () => {
    const evidence = reconstructionEvidence(), input = verification(evidence);
    const before = structuredClone({ evidence,input });
    const result = evaluateCutoverOpening(evidence,input);
    expect(result.ready).toBe(true); expect(result.blockers).toEqual([]);
    expect(result.plan.orders[0].lines[0]).toMatchObject({ requestedQty:"6",reservedQty:"3",pickedQty:"2",freshDemandQty:"1" });
    expect(result.plan.orders[0].lines[0].allocations[0].lots[0].originalCosts[0].totalCostMills).toBe("18014398509481990");
    expect(result.plan.evidenceHash).not.toBe(result.sourceEvidenceHash);
    expect({ evidence,input }).toEqual(before);
    expect(planFreshCutoverClaims(reconstructionSupply(evidence),result.plan).freshReservationsByLevel).toEqual([{ inventoryLevelId:10,reservedQty:"1" }]);
  });
  it("retains unknown historical journals and ignored echoes as unresolved, not repaired", () => {
    const evidence = reconstructionEvidence(); evidence.journals[0].unknownCount = "1";
    evidence.journals[0].reservedQty = "0";
    evidence.shipmentReviewEvidence = [{ id:"echo:1",kind:"channel_fulfillment_acknowledgment",status:"ignored",evidenceHash:"f".repeat(64) }];
    const result = evaluateCutoverOpening(evidence,verification(evidence));
    expect(planCutoverReconstruction(evidence).ready).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.historicalExceptions.map(row => row.code)).toEqual(expect.arrayContaining([
      "JOURNAL_CUSTODY_UNKNOWN", "SHIPMENT_ACKNOWLEDGMENT_REQUIRES_INVENTORY_RECONCILIATION",
    ]));
    expect(evidence.journals[0]).toMatchObject({ unknownCount:"1",reservedQty:"0" });
    expect(result.plan.openingBalance?.historicalExceptionCount).toBe(result.historicalExceptions.length);
  });
  it("does not silently apply an old verification after any raw history or current stock change", () => {
    const evidence = reconstructionEvidence(), input = verification(evidence);
    evidence.journals[0].journalHash = "f".repeat(64);
    const result = evaluateCutoverOpening(evidence,input);
    expect(result.ready).toBe(false); expect(result.plan.orders).toEqual([]);
    expect(result.blockers.map(row=>row.code)).toContain("OPENING_SOURCE_CHANGED");
  });
  it.each(["levels","lots"] as const)("requires the full verified %s census", key => {
    const evidence = reconstructionEvidence(), input = verification(evidence); input[key] = [];
    expect(codes(evidence,input)).toContain(key === "levels" ? "OPENING_LEVEL_VERIFICATION_MISMATCH" : "OPENING_LOT_VERIFICATION_MISMATCH");
  });
  it.each(["variantQty","reservedQty","pickedQty","packedQty"] as const)("does not correct a %s counter during verification", field => {
    const evidence = reconstructionEvidence(), input = verification(evidence); input.levels[0][field] = "19";
    expect(codes(evidence,input)).toContain("OPENING_LEVEL_VERIFICATION_MISMATCH");
  });
  it.each(["onHandQty","reservedQty","pickedQty","unitCostMills","poUnitCostMills","packagingUnitCostMills","landedUnitCostMills"] as const)("does not replace lot %s", field => {
    const evidence = reconstructionEvidence(), input = verification(evidence); input.lots[0][field] = "19";
    expect(codes(evidence,input)).toContain("OPENING_LOT_VERIFICATION_MISMATCH");
  });
  it.each(["missing","duplicate","extra"])("rejects %s current owner coverage", kind => {
    const evidence = reconstructionEvidence(), input = verification(evidence);
    if (kind === "missing") input.owners=[];
    else input.owners.push({ ...input.owners[0],orderItemId:kind === "extra" ? 123 : 11 });
    expect(codes(evidence,input)).toContain("OPENING_OWNER_COVERAGE_MISMATCH");
  });
  it.each(["orderId","remainingQty","pickedQty"])("rejects changed owner %s", field => {
    const evidence = reconstructionEvidence(), input = verification(evidence);
    if (field === "orderId") input.owners[0].orderId=2; else if (field === "remainingQty") input.owners[0].remainingQty="5"; else input.owners[0].pickedQty="1";
    expect(codes(evidence,input)).toContain("OPENING_CURRENT_DEMAND_MISMATCH");
  });
  it("requires verified allocations to exhaust every reserved and picked unit", () => {
    const evidence = reconstructionEvidence(), input = verification(evidence); input.owners[0].allocations[0].lots[0].reservedQty="2";
    expect(codes(evidence,input)).toEqual(expect.arrayContaining(["OPENING_OWNER_ALLOCATION_MISMATCH","OPENING_LOT_OWNERSHIP_INCOMPLETE"]));
  });
  it.each(["missing","duplicate","wrong_owner","wrong_lot","wrong_total"])("blocks %s original picked cost evidence", mode => {
    const evidence = reconstructionEvidence();
    if (mode === "wrong_owner") evidence.costs[0].orderId=2;
    if (mode === "wrong_lot") evidence.costs[0].inventoryLotId=5;
    if (mode === "wrong_total") evidence.costs[0].totalCostMills="1";
    const input=verification(evidence);
    if (mode === "missing") input.owners[0].allocations[0].lots[0].originalCostIds=[];
    if (mode === "duplicate") input.owners[0].allocations[0].lots[0].originalCostIds=[9,9];
    expect(evaluateCutoverOpening(evidence,input).ready).toBe(false);
    expect(codes(evidence,input).some(code => code.startsWith("OPENING_PICK_COST"))).toBe(true);
  });
  it.each(["-1","21"])("does not waive invalid current reserved counter %s", reserved => {
    const evidence=reconstructionEvidence(); evidence.levels[0].reservedQty=reserved;
    expect(codes(evidence)).toContain("OPENING_CURRENT_BALANCE_INVALID");
  });
  it("preserves packed custody as a blocker instead of zeroing it", () => {
    const evidence=reconstructionEvidence(); evidence.levels[0].packedQty="1";
    expect(codes(evidence)).toContain("OPENING_CURRENT_BALANCE_INVALID");
  });
  it("does not turn an empty-bin promise into a counter release", () => {
    const evidence=reconstructionEvidence(); evidence.levels[0].variantQty="0"; evidence.lots[0].onHandQty="0";
    const result=evaluateCutoverOpening(evidence,verification(evidence)); expect(result.ready).toBe(false);
    expect(result.plan.legacyPromiseReleases).toEqual([]);
  });
  it.each(["pending","processing","failed","review"])("retains %s receipt work as a current blocker", status => {
    const evidence=reconstructionEvidence(); evidence.shipmentReviewEvidence=[{ id:"7",kind:"channel_fulfillment_receipt",status,evidenceHash:"d".repeat(64) }];
    expect(codes(evidence)).toContain("SHIPMENT_RECEIPT_REQUIRES_REVIEW");
  });
  it("retains unknown review kinds, even if they use ignored status", () => {
    const evidence=reconstructionEvidence(); evidence.shipmentReviewEvidence=[{ id:"7",kind:"future_review",status:"ignored",evidenceHash:"d".repeat(64) }];
    expect(codes(evidence)).toContain("SHIPMENT_RECEIPT_REQUIRES_REVIEW");
  });
  it.each(["review","delivered","future_state"])("does not archive unsupported/current physical lifecycle %s", packageStatus => {
    const evidence=reconstructionEvidence(); evidence.physicalItems=[{ id:"100",physicalShipmentId:"99",orderItemId:11,
      replacementForOrderItemId:null,legacySourceShipmentItemId:null,packageAllocationEntryId:null,productVariantId:101,sku:"P5",
      originalQuantity:1,adjustmentQuantity:0,effectiveQuantity:"1",purpose:"customer_fulfillment",packageStatus }];
    expect(codes(evidence)).toContain("PHYSICAL_SHIPMENT_REQUIRES_REVIEW");
  });
  it("retains accepted OMS coverage checks on original commercial quantities", () => {
    const evidence=reconstructionEvidence(); evidence.acceptedOmsDemand=[{ lineId:"999",orderId:"1",productVariantId:101,sku:"P5",authorizedQty:"1",materializedQty:"1",authorizationStatus:"authorized" }];
    expect(codes(evidence)).toContain("OMS_ACCEPTED_DEMAND_NOT_COVERED");
  });
  it("never creates claims for a terminal owner or reallocates their picked stock by omission", () => {
    const evidence=reconstructionEvidence(); evidence.orders[0].status="completed";
    const input=verification(evidence); input.owners=[];
    expect(requiredOpeningItems(evidence)).toEqual([]);
    expect(codes(evidence,input)).toContain("OPENING_LOT_OWNERSHIP_INCOMPLETE");
  });
  it("preserves an independent build hold in addition to customer stock", () => {
    const evidence=reconstructionEvidence(); evidence.buildReservations.push({ ...standaloneBuildReservation(),buildOrderStatus:"released" });
    evidence.levels[0].reservedQty="6"; evidence.lots[0].reservedQty="6";
    const result=evaluateCutoverOpening(evidence,verification(evidence));
    expect(result.ready).toBe(true); expect(result.plan.retainedIndependentBuildReservationIds).toEqual([evidence.buildReservations[0].reservationId]);
    expect(result.plan.orders[0].lines[0].reservedQty).toBe("3");
  });
  it("rejects existing canonical lineage", () => {
    const evidence=reconstructionEvidence(); evidence.canonicalClaimCount="1";
    expect(codes(evidence)).toContain("EXISTING_CANONICAL_LINEAGE_REQUIRES_REVIEW");
  });
  it("rejects a partial fulfillment opening that the cumulative WMS picker cannot operate", () => {
    const evidence=reconstructionEvidence(); evidence.items[0].quantity=8; evidence.items[0].pickedQuantity=4; evidence.items[0].fulfilledQuantity=2;
    evidence.journals[0].shippedQty="2";
    evidence.costs.push({ ...evidence.costs[0],id:10 });
    const input=verification(evidence), result=evaluateCutoverOpening(evidence,input);
    expect(result.ready).toBe(false); expect(result.plan.orders).toEqual([]);
    expect(result.blockers.map(row=>row.code)).toContain("OPENING_PARTIAL_FULFILLMENT_RUNTIME_UNSUPPORTED");
    expect(evidence.items[0]).toMatchObject({ quantity:8,pickedQuantity:4,fulfilledQuantity:2 });
    expect(evidence.costs).toHaveLength(2);
  });
  it.each(["source","physical"] as const)("does not hide unfinished %s work when remaining demand becomes zero", kind => {
    const evidence=reconstructionEvidence(); evidence.items[0].quantity=2; evidence.items[0].pickedQuantity=2; evidence.items[0].fulfilledQuantity=2;
    evidence.levels[0].reservedQty="0"; evidence.levels[0].pickedQty="0";
    evidence.lots[0].reservedQty="0"; evidence.lots[0].pickedQty="0";
    const input=verification(evidence);
    input.owners[0]={ orderId:1,orderItemId:11,remainingQty:"0",reservedQty:"0",pickedQty:"0",allocations:[] };
    if (kind==="source") evidence.sourceItems=[{ id:100,shipmentId:99,headerOrderId:1,orderItemId:11,productVariantId:101,
      quantity:2,purpose:"customer_fulfillment",fromLocationId:null,replacementForOrderItemId:null,correctionForShipmentItemId:null,shipmentStatus:"labeled",shipmentHeld:false }];
    else evidence.physicalItems=[{ id:"100",physicalShipmentId:"99",orderItemId:11,replacementForOrderItemId:null,
      legacySourceShipmentItemId:null,packageAllocationEntryId:null,productVariantId:101,sku:"P5",
      originalQuantity:2,adjustmentQuantity:0,effectiveQuantity:"2",purpose:"customer_fulfillment",packageStatus:"review" }];
    input.expectedEvidenceHash=reconstructionEvidenceHash(evidence);
    const result=evaluateCutoverOpening(evidence,input);
    expect(result.ready).toBe(false); expect(result.plan.orders).toEqual([]);
    expect(result.blockers.map(row=>row.code)).toContain("OPENING_ZERO_REMAINING_PACKAGE_REQUIRES_REVIEW");
    if (kind==="source") evidence.sourceItems[0].shipmentStatus="shipped"; else evidence.physicalItems[0].packageStatus="shipped";
    input.expectedEvidenceHash=reconstructionEvidenceHash(evidence);
    const closed=evaluateCutoverOpening(evidence,input);
    expect(closed.ready).toBe(true); expect(closed.plan.orders.flatMap(order=>order.lines)).toEqual([]);
  });
  it("rejects direct-shipment progress that the current claim runtime cannot adopt consistently", () => {
    const evidence=reconstructionEvidence(); evidence.items[0].fulfilledQuantity=3; evidence.items[0].pickedQuantity=0;
    const input=verification(evidence); input.owners[0].pickedQty="0";
    expect(codes(evidence,input)).toContain("OPENING_CURRENT_DEMAND_MISMATCH");
  });
  it.each([[-1,2,0],[6,-1,0],[6,2,-1],[6,7,0],[6,2,7]])("does not normalize invalid original progress %s/%s/%s into fresh demand", (quantity,pickedQuantity,fulfilledQuantity) => {
    const evidence=reconstructionEvidence(); Object.assign(evidence.items[0],{ quantity,pickedQuantity,fulfilledQuantity });
    const input=verification(reconstructionEvidence()); input.expectedEvidenceHash=reconstructionEvidenceHash(evidence);
    if (quantity-fulfilledQuantity >= 0) input.owners[0].remainingQty=String(quantity-fulfilledQuantity);
    expect(codes(evidence,input)).toContain("OPENING_CURRENT_DEMAND_MISMATCH");
  });
  it("resolves multiple reserved owners/lots ONLY with exhaustive explicit verified bindings", () => {
    const evidence=reconstructionEvidence(); evidence.items[0].pickedQuantity=0; evidence.costs=[];
    evidence.items.push({ ...evidence.items[0],id:12,omsOrderLineId:"12" });
    evidence.levels[0].pickedQty="0"; evidence.levels[0].reservedQty="6";
    evidence.lots[0]={ ...evidence.lots[0],onHandQty:"10",pickedQty:"0",reservedQty:"3" };
    evidence.lots.push({ ...evidence.lots[0],id:5 });
    const input=verification(evidence); input.owners=[11,12].map((orderItemId,index)=>({ orderId:1,orderItemId,remainingQty:"6",reservedQty:"3",pickedQty:"0",
      allocations:[{ inventoryLevelId:10,lots:[{ inventoryLotId:4+index,reservedQty:"3",pickedQty:"0",originalCostIds:[] }] }] }));
    const result=evaluateCutoverOpening(evidence,input); expect(result.ready).toBe(true);
    expect(result.plan.orders[0].lines.map(line=>line.allocations[0].lots[0].inventoryLotId)).toEqual([4,5]);
  });
  it("is deterministic for row delivery order and sensitive to independent verification identity", () => {
    const evidence=reconstructionEvidence(), input=verification(evidence);
    const result=evaluateCutoverOpening(evidence,input); input.levels.reverse(); input.lots.reverse(); input.owners.reverse();
    expect(evaluateCutoverOpening(evidence,input)).toEqual(result);
    input.verificationReference+=" corrected reference";
    expect(evaluateCutoverOpening(evidence,input).plan.evidenceHash).not.toBe(result.plan.evidenceHash);
  });
  it.each(["verificationReference","verificationEvidenceHash","verifiedAt","historicalDisposition"])("requires explicit %s", field => {
    const input: Record<string,unknown>=verification(reconstructionEvidence()); delete input[field];
    expect(openingVerificationSchema.safeParse(input).success).toBe(false);
  });
});
