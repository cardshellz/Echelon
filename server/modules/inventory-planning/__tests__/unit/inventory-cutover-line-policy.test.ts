import { describe, expect, it } from "vitest";
import { cutoverReconstructionEvidenceSchema, type CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { requiredOpeningItems, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { cutoverLineTracksInventory } from "@shared/inventory/cutover-line-policy";
import { planCutoverReconstruction, reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { buildInventoryCutoverPreflight } from "../../domain/inventory-cutover-preflight";
import { evaluateCutoverOpening } from "../../domain/inventory-cutover-opening";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { cutoverPreflightFacts } from "../fixtures/inventory-cutover-preflight.fixture";

function untouchedLine(tracked = false): CutoverReconstructionEvidence {
  const evidence = reconstructionEvidence();
  evidence.journals = []; evidence.costs = [];
  evidence.levels[0] = { ...evidence.levels[0], reservedQty: "0", pickedQty: "0" };
  evidence.lots[0] = { ...evidence.lots[0], reservedQty: "0", pickedQty: "0" };
  evidence.items[0] = { ...evidence.items[0], quantity: 1, pickedQuantity: 0,
    catalogProductId: 20, inventoryTracking: tracked };
  evidence.acceptedOmsDemand = [{ lineId: "11", orderId: "9", sku: null, productVariantId: 101,
    catalogProductId: 20, inventoryTracking: tracked, authorizedQty: "1", materializedQty: "1", authorizationStatus: "authorized" }];
  return evidence;
}

function preflight(evidence: CutoverReconstructionEvidence) {
  const facts = cutoverPreflightFacts();
  facts.demand = { ...facts.demand, orders: evidence.orders, items: evidence.items,
    sourceItems: evidence.sourceItems, physicalItems: evidence.physicalItems };
  facts.variants = evidence.variants.map(variant => ({ ...variant, salesEligibility: "sellable" }));
  return buildInventoryCutoverPreflight(facts);
}

function opening(evidence: CutoverReconstructionEvidence) {
  const verification: OpeningVerification = { contractVersion: "inventory_cutover_opening_v2",
    expectedEvidenceHash: reconstructionEvidenceHash(evidence), expectedAuthorityRevision: "1", expectedConfigurationRunId: null,
    verificationReference: "Test fixture observation", verificationEvidenceHash: "e".repeat(64),
    verifiedAt: "2026-09-26T18:15:44.330Z", historicalDisposition: "preserve_unresolved",
    levels: evidence.levels, lots: evidence.lots,
    owners: requiredOpeningItems(evidence).map(item => ({ orderId: item.orderId, orderItemId: item.id,
      remainingQty: String(item.quantity), reservedQty: "0", pickedQty: "0", allocations: [] })) };
  return evaluateCutoverOpening(evidence, verification);
}

describe("cutover saved order identity and tracking policy", () => {
  it.each([false, true])("covers a blank provider SKU through exact IDs (inventory tracking %s)", tracked => {
    const evidence = untouchedLine(tracked), before = structuredClone(evidence);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.blockers).toEqual([]);
    expect(plan.orders.flatMap(order => order.lines)).toHaveLength(tracked ? 1 : 0);
    expect(requiredOpeningItems(evidence)).toHaveLength(tracked ? 1 : 0);
    expect(preflight(evidence).lines[0]).toMatchObject({ disposition: tracked ? "unstarted_demand" : "no_inventory_demand" });
    expect(opening(evidence).ready).toBe(true);
    expect(evidence).toEqual(before);
  });

  it.each([false, true])("saved tracking %s survives an opposite current catalog default", tracked => {
    const evidence = untouchedLine(tracked);
    evidence.variants[0].trackInventory = !tracked;
    expect(planCutoverReconstruction(evidence).orders).toHaveLength(tracked ? 1 : 0);
    expect(requiredOpeningItems(evidence)).toHaveLength(tracked ? 1 : 0);
    expect(preflight(evidence).lines[0].disposition).toBe(tracked ? "unstarted_demand" : "no_inventory_demand");
    expect(opening(evidence).ready).toBe(true);
  });

  const conflicts: Array<[string, (evidence: CutoverReconstructionEvidence) => void]> = [
    ["missing OMS variant", e => { e.acceptedOmsDemand[0].productVariantId = null; }],
    ["missing WMS variant", e => { e.items[0].productId = null; }],
    ["conflicting WMS variant", e => { e.items[0].productId = 102; }],
    ["conflicting OMS variant", e => { e.acceptedOmsDemand[0].productVariantId = 102; }],
    ["conflicting OMS product", e => { e.acceptedOmsDemand[0].catalogProductId = 21; }],
    ["conflicting WMS product", e => { e.items[0].catalogProductId = 21; }],
    ["conflicting source SKU", e => { e.acceptedOmsDemand[0].sku = "ANOTHER-SKU"; }],
    ["lost physical shipping obligation", e => { e.items[0].requiresShipping = 0; }],
    ["conflicting policy", e => { e.items[0].inventoryTracking = true; }],
    ["unknown WMS policy with conflicting catalog fallback", e => { e.items[0].inventoryTracking = null; }],
    ["missing catalog variant", e => { e.variants = []; }],
    ["missing WMS line", e => { e.items = []; }],
    ["quantity conflict", e => { e.items[0].quantity = 2; }],
    ["materialization conflict", e => { e.acceptedOmsDemand[0].materializedQty = "0"; }],
    ["unfinished terminal owner", e => { e.orders[0].status = "shipped"; }],
    ["revoked authorization", e => { e.acceptedOmsDemand[0].authorizationStatus = "revoked"; }],
  ];
  it.each(conflicts)("retains %s as an accepted-demand blocker", (_name, mutate) => {
    const evidence = untouchedLine(); mutate(evidence);
    expect(planCutoverReconstruction(evidence).blockers).toContainEqual(expect.objectContaining({ code: "OMS_ACCEPTED_DEMAND_NOT_COVERED" }));
    expect(opening(evidence).ready).toBe(false);
  });

  it("retains explicit conflicting non-stock identity in the opening worksheet and preflight", () => {
    const evidence = untouchedLine(); evidence.items[0].catalogProductId = 21;
    expect(requiredOpeningItems(evidence)).toHaveLength(1);
    expect(preflight(evidence).lines[0]).toMatchObject({ disposition: "review_required", findingCodes: ["VARIANT_IDENTITY_CONFLICT"] });
  });

  it("permits a fully fulfilled retired identity without recreating demand", () => {
    const evidence = untouchedLine(); evidence.orders[0].status = "shipped";
    evidence.items[0].fulfilledQuantity = 1; evidence.items[0].pickedQuantity = 1; evidence.variants[0].isActive = false;
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready: true, orders: [], blockers: [] });
  });

  it.each(["reservedQty", "pickedQty"] as const)("never discards non-stock %s evidence", field => {
    const evidence = untouchedLine();
    evidence.journals = [{ ...reconstructionEvidence().journals[0], reservedQty: "0", pickedQty: "0", [field]: "1" }];
    expect(planCutoverReconstruction(evidence).blockers).toContainEqual(expect.objectContaining({ code: "NONINVENTORY_ITEM_ENCUMBERED" }));
  });

  it("keeps a physical non-stock shipping obligation but does not create a stock claim", () => {
    const evidence = untouchedLine();
    evidence.sourceItems = [{ id: 91, shipmentId: 90, headerOrderId: 1, orderItemId: 11,
      replacementForOrderItemId: null, correctionForShipmentItemId: null, productVariantId: null,
      quantity: 1, purpose: "customer_fulfillment", fromLocationId: null, shipmentStatus: "queued", shipmentHeld: false }];
    const before = structuredClone(evidence);
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready: true, orders: [] });
    expect(preflight(evidence).lines[0].disposition).toBe("no_inventory_demand");
    expect(opening(evidence).ready).toBe(true);
    expect(evidence).toEqual(before);
  });

  it.each([null, undefined])("keeps the legacy catalog fallback for missing snapshot %s without treating unknown as false", policy => {
    const evidence = untouchedLine(); evidence.items[0].inventoryTracking = policy;
    evidence.acceptedOmsDemand[0].inventoryTracking = policy;
    expect(requiredOpeningItems(evidence)).toHaveLength(1);
    expect(planCutoverReconstruction(evidence).orders).toHaveLength(1);
    expect(cutoverLineTracksInventory(evidence.items[0], null)).toBeNull();
    evidence.variants[0].trackInventory = false;
    expect(requiredOpeningItems(evidence)).toHaveLength(0);
  });

  it("does not add default snapshot fields or change legacy capture bytes", () => {
    const evidence = reconstructionEvidence();
    expect(cutoverReconstructionEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(reconstructionEvidenceHash(evidence)).toBe(reconstructionEvidenceHash(structuredClone(evidence)));
    const changed = structuredClone(evidence); changed.items[0].inventoryTracking = false;
    expect(reconstructionEvidenceHash(changed)).not.toBe(reconstructionEvidenceHash(evidence));
  });
});
