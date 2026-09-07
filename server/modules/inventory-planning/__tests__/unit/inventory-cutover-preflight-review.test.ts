import { describe, expect, it } from "vitest";
import { inventoryCutoverLineSchema } from "@shared/types/inventory-cutover-preflight";
import type { WmsCutoverSourceItem, WmsCutoverPhysicalItem } from "@shared/types/inventory-cutover-demand";
import { buildInventoryCutoverPreflight } from "../../domain/inventory-cutover-preflight";
import { cutoverPreflightFacts, standaloneBuildReservation, canonicalResource } from "../fixtures/inventory-cutover-preflight.fixture";

describe("independent cutover evidence review regressions", () => {
  it.each(["wrong_variant", "combined_quantity", "both"])("flags %s source evidence without deriving new claims", (kind) => {
    const facts = cutoverPreflightFacts();
    const source = sourceItem();
    if (kind !== "combined_quantity") source.productVariantId = 999;
    facts.demand.sourceItems = kind === "wrong_variant" ? [source] : [source, { ...source, id: 2 }];

    const report = buildInventoryCutoverPreflight(facts);

    expect(report.outcome).toBe("review_required");
    expect(report.lines[0]).toMatchObject({ candidateDemandQty: null, disposition: "review_required" });
    expect(report.lines[0]!.findingCodes).toContain("DEMAND_CUSTODY_RECONCILIATION_REQUIRED");
    expect(report).toMatchObject({ operationalWriteAttempted: false, activationReadinessEvaluated: false });
  });

  it("keeps a correct unshipped label as intended demand, not picked inventory", () => {
    const facts = cutoverPreflightFacts(); facts.demand.sourceItems = [sourceItem()];
    expect(buildInventoryCutoverPreflight(facts).lines[0]).toMatchObject({ candidateDemandQty: "4", disposition: "unstarted_demand" });
  });

  it("surfaces a selected order's source pointing to an item outside the captured cohort", () => {
    const facts = cutoverPreflightFacts();
    facts.demand.sourceItems = [{ ...sourceItem(), orderItemId: 999 }];
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.outcome).toBe("review_required");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "SHIPMENT_SOURCE_ORDER_MEMBERSHIP_CONFLICT", orderId: 1,
    }));
  });

  it.each(["0", "2", null])("flags standalone open3 against raw lot reserved %s even when the level balances", (lotQtyReserved) => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "3";
    facts.encumbrance.buildReservations = [{ ...standaloneBuildReservation(), lotQtyReserved }];

    const report = buildInventoryCutoverPreflight(facts);

    expect(report.outcome).toBe("review_required");
    expect(report.findings.map((finding) => finding.code)).toContain("BUILD_LOT_RESERVED_SHORTFALL");
    expect(report.inventoryLevels[0]).toMatchObject({ recordedReservedQty: "3", standaloneBuildOpenQty: "3", unattributedReservedQty: "0" });
  });

  it("compares combined standalone reservations against one shared lot", () => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "6";
    facts.encumbrance.buildReservations = [standaloneBuildReservation(), { ...standaloneBuildReservation(), reservationId: 2, buildOrderComponentId: 3 }];
    expect(buildInventoryCutoverPreflight(facts).findings.map((finding) => finding.code)).toContain("BUILD_LOT_RESERVED_SHORTFALL");
  });

  it("does not treat excess raw lot reservations as proven free stock", () => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "3";
    facts.encumbrance.buildReservations = [{ ...standaloneBuildReservation(), lotQtyReserved: "9" }];
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.inventoryLevels[0]!.standaloneBuildOpenQty).toBe("3");
    expect(report.activationReadinessEvaluated).toBe(false);
    expect(report.findings.map((finding) => finding.code)).not.toContain("BUILD_LOT_RESERVED_SHORTFALL");
  });

  it("flags two valid individual build projections whose sum exceeds their shared claim resource", () => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.canonicalResources = [canonicalResource()];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "4";
    facts.encumbrance.buildReservations = [claimProjection(1, "3"), claimProjection(2, "3")];

    const report = buildInventoryCutoverPreflight(facts);

    expect(report.findings.map((finding) => finding.code)).toContain("BUILD_CLAIM_PROJECTIONS_EXCEED_HOLD");
    expect(report.findings.map((finding) => finding.code)).not.toContain("BUILD_CLAIM_LINEAGE_UNVERIFIED");
    expect(report.inventoryLevels[0]).toMatchObject({ canonicalOpenQty: "4", standaloneBuildOpenQty: "0", unattributedReservedQty: "0" });
  });

  it("does not double-count supported projections within their shared canonical resource", () => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.canonicalResources = [canonicalResource()];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "4";
    facts.encumbrance.buildReservations = [claimProjection(1, "2"), claimProjection(2, "2")];
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.findings.map((finding) => finding.code)).not.toContain("BUILD_CLAIM_PROJECTIONS_EXCEED_HOLD");
    expect(report.inventoryLevels[0]).toMatchObject({ canonicalOpenQty: "4", standaloneBuildOpenQty: "0", unattributedReservedQty: "0" });
  });

  it.each([{ lotVariantId: 999 }, { lotLocationId: 999 }])("checks the actual lot identity for claim-backed builds: %j", (change) => {
    const facts = cutoverPreflightFacts();
    facts.encumbrance.canonicalResources = [canonicalResource()];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "4";
    facts.encumbrance.buildReservations = [{ ...claimProjection(1, "3"), ...change }];
    expect(buildInventoryCutoverPreflight(facts).findings.map((finding) => finding.code)).toContain("BUILD_CLAIM_LINEAGE_UNVERIFIED");
  });

  it.each([null, "invented", "shipped", "cancelled"])("does not infer physical demand for unknown or terminal captured order state %s", (status) => {
    const facts = cutoverPreflightFacts(); facts.demand.orders[0]!.status = status;
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.lines[0]!.candidateDemandQty).toBeNull();
    expect(report.lines[0]!.findingCodes).toContain("ORDER_STATE_REVIEW");
  });

  it.each(["order", "item", "source", "physical", "variant", "level", "position", "resource", "reservation"])(
    "rejects duplicate %s evidence instead of counting or overwriting it", (kind) => {
      const facts = cutoverPreflightFacts();
      if (kind === "order") facts.demand.orders.push({ ...facts.demand.orders[0]! });
      if (kind === "item") facts.demand.items.push({ ...facts.demand.items[0]! });
      if (kind === "source") facts.demand.sourceItems = [sourceItem(), sourceItem()];
      if (kind === "physical") facts.demand.physicalItems = [physicalItem(), physicalItem()];
      if (kind === "variant") facts.variants.push({ ...facts.variants[0]! });
      if (kind === "level") facts.encumbrance.inventoryLevels.push({ ...facts.encumbrance.inventoryLevels[0]! });
      if (kind === "position") facts.encumbrance.inventoryLevels.push({ ...facts.encumbrance.inventoryLevels[0]!, inventoryLevelId: 20 });
      if (kind === "resource") facts.encumbrance.canonicalResources = [canonicalResource(), canonicalResource()];
      if (kind === "reservation") facts.encumbrance.buildReservations = [standaloneBuildReservation(), standaloneBuildReservation()];
      expect(() => buildInventoryCutoverPreflight(facts)).toThrow("duplicate");
    },
  );

  it.each([
    { candidateDemandQty: "3" }, { recordedPickedQty: "1" }, { recordedFulfilledQty: "1" },
    { disposition: "review_required", candidateDemandQty: null, findingCodes: [] },
    { disposition: "review_required", candidateDemandQty: "4", findingCodes: ["REVIEW"] },
    { disposition: "no_inventory_demand", candidateDemandQty: "4" },
  ])("rejects a contradictory output line: %j", (change) => {
    const line = buildInventoryCutoverPreflight(cutoverPreflightFacts()).lines[0]!;
    expect(inventoryCutoverLineSchema.safeParse({ ...line, ...change }).success).toBe(false);
  });
});

function sourceItem(): WmsCutoverSourceItem {
  return { id: 1, shipmentId: 2, headerOrderId: 1, orderItemId: 11,
    replacementForOrderItemId: null, correctionForShipmentItemId: null, productVariantId: 101, quantity: 4,
    purpose: "customer_fulfillment", fromLocationId: 100, shipmentStatus: "labeled", shipmentHeld: false };
}

function physicalItem(): WmsCutoverPhysicalItem {
  return { id: "1", physicalShipmentId: "2", orderItemId: 11, replacementForOrderItemId: null,
    legacySourceShipmentItemId: 1, packageAllocationEntryId: null, productVariantId: 101, sku: "P5",
    originalQuantity: 4, adjustmentQuantity: 0, effectiveQuantity: "4", purpose: "customer_fulfillment", packageStatus: "not_confirmed" };
}

function claimProjection(reservationId: number, open: string) {
  return { ...standaloneBuildReservation(), reservationId, inventoryLotId: reservationId + 10,
    reservedQty: open, consumedQty: "0", releasedQty: "0", lotQtyReserved: open,
    reservationOwner: "availability_claim", availabilityClaimId: "2", availabilityClaimLotAllocationId: String(reservationId + 100),
    claimLotResourceId: "1", claimLotInventoryLotId: reservationId + 10, claimLotOpenQty: open };
}
