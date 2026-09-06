import { describe, expect, it, vi } from "vitest";
import { shipmentLineFromPoSchema, shipmentLinePatchSchema, shipmentLineDeleteSchema, shipmentPackingListImportSchema, shipmentPackingListRowSchema } from "@shared/procurement/shipment-line-command";
import { computeShipmentLinePhysicalTotals, validateShipmentPhysicalTotals } from "../../shipment-line-physical-values";
import { shipmentLineVersion } from "../../shipment-line-version";
import { classifyShipmentLineCommandFailure, createShipmentLineCommands, shipmentLineCommandScope } from "../../shipment-line-commands";
import { ShipmentSourceCapacityError } from "../../shipment-source-capacity";

const version = "a".repeat(64);
describe("shipment line input boundary", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "1"])("rejects invalid piece count %s", (qtyShipped) => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ sku: "SKU", qtyShipped }).success).toBe(false);
  });
  it.each(["inboundShipmentId", "purchaseOrderId", "purchaseOrderLineId", "productVariantId", "sku", "allocatedCostCents", "landedUnitCostCents", "updatedAt", "createdAt", "totalWeightKg"])("rejects server-owned patch field %s", (field) => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, notes: "review", [field]: 1 }).success).toBe(false);
  });
  it("requires versions and changed fields", () => {
    expect(shipmentLinePatchSchema.safeParse({ qtyShipped: 1 }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version }).success).toBe(false);
    expect(shipmentLineDeleteSchema.safeParse({}).success).toBe(false);
    expect(shipmentLineDeleteSchema.safeParse({ expectedVersion: version }).success).toBe(true);
  });
  it("supports explicit clearing without conflating null and omitted", () => {
    const result = shipmentLinePatchSchema.parse({ expectedVersion: version, weightKg: null, cartonCount: null });
    expect(result).toHaveProperty("weightKg", null);
    expect(result).not.toHaveProperty("qtyShipped");
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped: null }).success).toBe(false);
  });
  it.each(["-1", "1e3", "1.0001", "10000000", "NaN", "Infinity", "", " 1"])("rejects invalid weight %s", (weightKg) => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, weightKg }).success).toBe(false);
  });
  it("matches actual dimension column precision", () => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, weightKg: "9999999.999", lengthCm: "999999.99" }).success).toBe(true);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, lengthCm: "1.001" }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, cartonCount: 0 }).success).toBe(false);
  });
  it("accepts legacy selection modes without ambiguous or duplicate IDs", () => {
    expect(shipmentLineFromPoSchema.parse({ purchaseOrderId: 1 })).toEqual({ purchaseOrderId: 1 });
    expect(shipmentLineFromPoSchema.safeParse({ purchaseOrderId: 1, lineIds: [2] }).success).toBe(true);
    for (const body of [
      { purchaseOrderId: 1, lineIds: [2, 2] }, { purchaseOrderId: 1, lineIds: [] },
      { purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 1 }, { poLineId: 2, qty: 1 }] },
      { purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 1 }], lineIds: [2] },
    ]) expect(shipmentLineFromPoSchema.safeParse(body).success).toBe(false);
  });
  it("bounds imports and validates rows separately for partial acceptance", () => {
    expect(shipmentPackingListImportSchema.parse({ rows: [{ sku: "SKU", qtyShipped: 1 }, { qtyShipped: 0 }] }).rows).toHaveLength(2);
    expect(shipmentPackingListImportSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(shipmentPackingListImportSchema.safeParse({ rows: Array(501).fill({}) }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ sku: "SKU", qty_shipped: 1 }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 1 }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ sku: "SKU", qtyShipped: 1, grossVolumeCbm: "2" }).success).toBe(false);
  });
});

describe("physical line calculations", () => {
  it("preserves partial-carton pieces while dimensions use physical cartons", () => {
    const line = { qtyShipped: 501, cartonCount: 3, weightKg: "2", lengthCm: "10", widthCm: "20", heightCm: "30" };
    expect(computeShipmentLinePhysicalTotals(line)).toEqual({ totalWeightKg: "6.000", totalVolumeCbm: "0.018000", chargeableWeightKg: "6.000" });
    expect(line.qtyShipped).toBe(501);
  });
  it("cleared dimensions produce zero basis totals", () => {
    expect(computeShipmentLinePhysicalTotals({ qtyShipped: 501, cartonCount: null, weightKg: null })).toEqual({ totalWeightKg: "0.000", totalVolumeCbm: "0.000000", chargeableWeightKg: "0.000" });
  });
  it("rounds deterministically and rejects derived overflow", () => {
    expect(computeShipmentLinePhysicalTotals({ qtyShipped: 3, weightKg: "0.333" }).totalWeightKg).toBe("0.999");
    expect(() => computeShipmentLinePhysicalTotals({ qtyShipped: 1000, weightKg: "9999999.999" })).toThrow(/range/);
    expect(() => computeShipmentLinePhysicalTotals({ qtyShipped: 1, lengthCm: "999999.99", widthCm: "999999.99", heightCm: "999999.99" })).toThrow(/range/);
  });
  it("rejects aggregate integer overflow across valid individual lines", () => {
    const row = { qtyShipped: 2_147_483_647, cartonCount: null, totalWeightKg: null, totalVolumeCbm: null };
    expect(() => validateShipmentPhysicalTotals([row, { ...row, qtyShipped: 1 }])).toThrow(/integer range/);
  });
});

describe("durable line command boundary", () => {
  it("versions raw quantity, lineage, cost, and timestamp changes", () => {
    const line = { id: 1, inboundShipmentId: 2, qtyShipped: 501, cartonCount: 3, updatedAt: new Date("2026-09-06T00:00:00Z") } as any;
    const original = shipmentLineVersion(line);
    expect(shipmentLineVersion({ ...line })).toBe(original);
    for (const patch of [{ qtyShipped: 750 }, { cartonCount: 4 }, { purchaseOrderLineId: 99 }, { allocatedCostCents: 1 }, { updatedAt: new Date("2026-09-07T00:00:00Z") }]) expect(shipmentLineVersion({ ...line, ...patch })).not.toBe(original);
  });
  it("uses exact route scopes for all five operations", () => {
    expect(shipmentLineCommandScope({ operation: "add-from-po", resourceId: 1 }).routeTemplate).toBe("/api/inbound-shipments/:id/lines/from-po");
    expect(shipmentLineCommandScope({ operation: "import", resourceId: 1 }).routeTemplate).toBe("/api/inbound-shipments/:id/lines/import-packing-list");
    expect(shipmentLineCommandScope({ operation: "resolve-dimensions", resourceId: 1 }).method).toBe("POST");
    expect(shipmentLineCommandScope({ operation: "update", resourceId: 1 }).resourceKey).toBe("shipment_line:1");
    expect(shipmentLineCommandScope({ operation: "delete", resourceId: 1 }).method).toBe("DELETE");
  });
  it("rejects absent actors and mismatched principal before invoking work", async () => {
    const executeLineCommandInTransaction = vi.fn();
    const commands = createShipmentLineCommands({ executeLineCommandInTransaction });
    const command = { operation: "import" as const, resourceId: 1, body: { rows: [] } };
    await expect(commands.execute(command, "", {} as any)).rejects.toMatchObject({ code: "SHIPMENT_LINE_ACTOR_REQUIRED" });
    await expect(commands.execute(command, "actor", {} as any)).rejects.toMatchObject({ code: "SHIPMENT_LINE_SCOPE_INVALID" });
    expect(executeLineCommandInTransaction).not.toHaveBeenCalled();
  });
  it("distinguishes source review from retryable infrastructure failures", () => {
    expect(classifyShipmentLineCommandFailure(new ShipmentSourceCapacityError("Review receipt evidence", 409, { code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED" }))).toMatchObject({ kind: "rejected", httpStatus: 409 });
    expect(classifyShipmentLineCommandFailure(new Error("connection lost"))).toMatchObject({ kind: "retryable" });
  });
});
