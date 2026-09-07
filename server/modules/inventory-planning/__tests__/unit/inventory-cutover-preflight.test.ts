import { describe, expect, it } from "vitest";
import { buildInventoryCutoverPreflight } from "../../domain/inventory-cutover-preflight";
import { InventoryCutoverPreflightService } from "../../application/inventory-cutover-preflight.service";
import { inventoryCutoverPreflightSchema } from "@shared/types/inventory-cutover-preflight";
import { cutoverPreflightFacts, standaloneBuildReservation, canonicalResource } from "../fixtures/inventory-cutover-preflight.fixture";

describe("inventory cutover preflight", () => {
  it("captures untouched demand without claiming activation readiness or changing input", () => {
    const facts = cutoverPreflightFacts(); const before = structuredClone(facts);
    const report = buildInventoryCutoverPreflight(facts);
    expect(facts).toEqual(before);
    expect(report).toMatchObject({ outcome: "evidence_captured", activationReadinessEvaluated: false,
      operationalWriteAttempted: false, excludedTerminalOrderCount: "24" });
    expect(report.lines[0]).toMatchObject({ candidateDemandQty: "4", disposition: "unstarted_demand" });
    expect(report.notEvaluated).toHaveLength(5);
    expect(buildInventoryCutoverPreflight(facts)).toEqual(report);
  });

  it.each(["pending", "in_progress", "short"])("does not cancel outstanding %s demand", (status) => {
    const facts = cutoverPreflightFacts(); facts.demand.items[0]!.status = status;
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBe("4");
  });

  it.each(["in_progress", "short", "completed"])("never deducts %s picker progress as proven custody", (status) => {
    const facts = cutoverPreflightFacts(); Object.assign(facts.demand.items[0]!, { status, pickedQuantity: 2 });
    const line = buildInventoryCutoverPreflight(facts).lines[0]!;
    expect(line.candidateDemandQty).toBeNull();
    expect(line.findingCodes).toContain("DEMAND_CUSTODY_RECONCILIATION_REQUIRED");
  });

  it("does not interpret externally projected fulfilled counters as a local pick", () => {
    const facts = cutoverPreflightFacts(); Object.assign(facts.demand.items[0]!, { status: "completed", pickedQuantity: 4, fulfilledQuantity: 4 });
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBeNull();
  });

  it.each(["digital", "nontracked"])("excludes %s items without needing a physical SKU claim", (kind) => {
    const facts = cutoverPreflightFacts();
    if (kind === "digital") { facts.demand.items[0]!.requiresShipping = 0; facts.variants = []; }
    else facts.variants[0]!.trackInventory = false;
    expect(buildInventoryCutoverPreflight(facts).lines[0]).toMatchObject({ candidateDemandQty: "0", disposition: "no_inventory_demand" });
  });

  it.each(["cancelled", "zero"])("creates no new demand for %s work", (kind) => {
    const facts = cutoverPreflightFacts();
    if (kind === "zero") facts.demand.items[0]!.quantity = 0; else facts.demand.items[0]!.status = "cancelled";
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBe("0");
  });

  it.each(["warehouse", "variant", "duplicate", "internal", "stored_identity", "negative", "overpicked", "external", "unknown_status"])("exposes %s evidence problems", (kind) => {
    const facts = cutoverPreflightFacts();
    if (kind === "warehouse") facts.demand.orders[0]!.warehouseId = null;
    if (kind === "variant") facts.variants = [];
    if (kind === "duplicate") facts.variants.push({ ...facts.variants[0]!, id: 102 });
    if (kind === "internal") facts.variants[0]!.salesEligibility = "internal_only";
    if (kind === "stored_identity") facts.demand.items[0]!.productId = 999;
    if (kind === "negative") facts.demand.items[0]!.quantity = -1;
    if (kind === "overpicked") facts.demand.items[0]!.pickedQuantity = 5;
    if (kind === "external") facts.demand.orders[0]!.status = "awaiting_3pl";
    if (kind === "unknown_status") facts.demand.items[0]!.status = "invented";
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBeNull();
  });

  it("keeps holds as demand without inventing a warehouse or cancelling the order", () => {
    const facts = cutoverPreflightFacts(); facts.demand.orders[0]!.onHold = 1; facts.demand.items[0]!.onHold = true;
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBe("4");
  });

  it("does not turn a label/source line into fulfilled or picked stock", () => {
    const facts = cutoverPreflightFacts();
    facts.demand.sourceItems.push({ id: 1, shipmentId: 2, headerOrderId: 1, orderItemId: 11,
      replacementForOrderItemId: null, correctionForShipmentItemId: null, productVariantId: 101, quantity: 4,
      purpose: "customer_fulfillment", fromLocationId: 100, shipmentStatus: "labeled", shipmentHeld: false });
    expect(buildInventoryCutoverPreflight(facts).lines[0]!.candidateDemandQty).toBe("4");
  });

  it("preserves standalone build holds and reports unattributed legacy reservations", () => {
    const facts = cutoverPreflightFacts(); facts.encumbrance.buildReservations = [standaloneBuildReservation()];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "5";
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.inventoryLevels[0]).toMatchObject({ physicalQty: "20", recordedReservedQty: "5", standaloneBuildOpenQty: "3", unattributedReservedQty: "2" });
    expect(report.findings.some((finding) => finding.code === "RESERVATION_OWNER_RECONCILIATION_REQUIRED")).toBe(true);
  });

  it("subtracts released, consumed and picked from canonical outstanding holds exactly once", () => {
    const facts = cutoverPreflightFacts(); facts.encumbrance.canonicalResources = [canonicalResource()];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "4";
    expect(buildInventoryCutoverPreflight(facts).inventoryLevels[0]).toMatchObject({ canonicalOpenQty: "4", unattributedReservedQty: "0" });
  });

  it("does not count claim-backed build projections as standalone holds", () => {
    const facts = cutoverPreflightFacts(); facts.encumbrance.canonicalResources = [canonicalResource()];
    facts.encumbrance.buildReservations = [{ ...standaloneBuildReservation(), reservationOwner: "availability_claim",
      availabilityClaimId: "2", availabilityClaimLotAllocationId: "3",
      claimLotResourceId: "1", claimLotInventoryLotId: 4, claimLotOpenQty: "3" }];
    facts.encumbrance.inventoryLevels[0]!.reservedQty = "4";
    expect(buildInventoryCutoverPreflight(facts).inventoryLevels[0]).toMatchObject({ canonicalOpenQty: "4", standaloneBuildOpenQty: "0", unattributedReservedQty: "0" });
  });

  it("never clamps negative or excessive claimed evidence to a trustworthy balance", () => {
    const facts = cutoverPreflightFacts(); facts.encumbrance.inventoryLevels[0]!.variantQty = "-2";
    facts.encumbrance.buildReservations = [standaloneBuildReservation()];
    const report = buildInventoryCutoverPreflight(facts);
    expect(report.inventoryLevels[0]).toMatchObject({ physicalQty: "-2", unattributedReservedQty: "-3" });
    expect(report.outcome).toBe("review_required");
  });

  it("does not subtract picked/packed counters from physical on-hand again", () => {
    const facts = cutoverPreflightFacts(); facts.encumbrance.inventoryLevels[0]!.pickedQty = "7";
    facts.encumbrance.inventoryLevels[0]!.packedQty = "2";
    expect(buildInventoryCutoverPreflight(facts).inventoryLevels[0]!.physicalQty).toBe("20");
  });

  it("includes missing canonical schema/authority as unknown rather than zero", () => {
    const facts = cutoverPreflightFacts(); facts.runtimeAuthority = null; facts.authorityRevision = null;
    facts.encumbrance.canonicalTablesStatus = "not_installed";
    expect(buildInventoryCutoverPreflight(facts).findings.map((finding) => finding.code)).toEqual([
      "CANONICAL_OWNER_TABLES_UNAVAILABLE", "RUNTIME_AUTHORITY_MISSING",
    ]);
  });

  it("rejects an invented readiness status or contradictory summary", () => {
    const report = buildInventoryCutoverPreflight(cutoverPreflightFacts());
    expect(inventoryCutoverPreflightSchema.safeParse({ ...report, activationReadinessEvaluated: true }).success).toBe(false);
    expect(inventoryCutoverPreflightSchema.safeParse({ ...report, summary: { ...report.summary, lines: 999 } }).success).toBe(false);
  });

  it("checks actor before reading; operational failures propagate without a false report", async () => {
    let reads = 0; const fault = new Error("database unavailable");
    const service = new InventoryCutoverPreflightService({ capture: async () => { reads += 1; throw fault; } });
    await expect(service.preview("")).rejects.toMatchObject({ status: 401 }); expect(reads).toBe(0);
    await expect(service.preview("operator")).rejects.toBe(fault); expect(reads).toBe(1);
  });
});
