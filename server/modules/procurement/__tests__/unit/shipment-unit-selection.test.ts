import { describe, expect, it } from "vitest";
import { convertUnitQuantity, toBasePieces, UnitQuantityError } from "@shared/procurement/unit-quantity";
import { shipmentLineFromPoSchema, shipmentLinePatchSchema, shipmentPackingListRowSchema } from "@shared/procurement/shipment-line-command";
import { projectShipmentUnits } from "../../domain/shipment-unit-selection";
const version = "a".repeat(64);
const unitSelection = { productVariantId: 20, unitsPerVariant: 1000, quantity: 525 };
const piece = { id: 10, productId: 1, unitsPerVariant: 1, sku: "EACH", name: "Each", isActive: true };
const pack = { ...piece, id: 20, unitsPerVariant: 1000, sku: "CASE", name: "Case of 1000" };
describe("exact quantity conversion shared by shipments and receipts", () => {
  it("converts configured cases while preserving integer piece authority", () => {
    expect(toBasePieces(525, 1000)).toBe(525000);
    expect(convertUnitQuantity(525000, 1, 1000)).toBe(525);
    expect(toBasePieces(0, 1000)).toBe(0);
  });
  it("keeps large intermediate receipt totals exact without exceeding the output bound", () => {
    expect(convertUnitQuantity(2147483647, 1000, 1000)).toBe(2147483647);
    expect(() => toBasePieces(2147483647, 1000)).toThrow(UnitQuantityError);
    expect(toBasePieces(2147483647, 1)).toBe(2147483647);
  });
  it.each([NaN, Infinity, -1, 0.5, 2147483648])("rejects invalid counts %s", (quantity) => {
    expect(() => toBasePieces(quantity, 1)).toThrow(UnitQuantityError);
  });
  it.each([NaN, Infinity, -1, 0, 0.5, 2147483648])("rejects invalid factors %s", (factor) => {
    expect(() => toBasePieces(1, factor)).toThrow(UnitQuantityError);
  });
  it("never rounds inexact receipt conversions", () => {
    expect(() => convertUnitQuantity(501, 1, 250)).toThrow(expect.objectContaining({ code: "UNIT_QUANTITY_INEXACT" }));
  });
});
describe("reviewed shipment unit request contracts", () => {
  it("accepts the same explicit evidence for adding, editing, and importing", () => {
    expect(shipmentLineFromPoSchema.parse({ purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 525000, unitSelection }] }).lineSelections?.[0].unitSelection).toEqual(unitSelection);
    expect(shipmentLinePatchSchema.parse({ expectedVersion: version, unitSelection }).unitSelection).toEqual(unitSelection);
    expect(shipmentPackingListRowSchema.parse({ qtyShipped: 525000, unitSelection }).unitSelection).toEqual(unitSelection);
  });
  it.each([0, -1, 1.5, 2147483648, NaN, Infinity])("reports invalid nested counts as schema failures %s", (quantity) => {
    const selected = { ...unitSelection, quantity };
    expect(shipmentLineFromPoSchema.safeParse({ purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 525000, unitSelection: selected }] }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped: 525000, unitSelection: selected }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 525000, unitSelection: selected }).success).toBe(false);
  });
  it("rejects contradictory reviewed base pieces on every command", () => {
    expect(shipmentLineFromPoSchema.safeParse({ purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 525001, unitSelection }] }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped: 525001, unitSelection }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 525001, unitSelection }).success).toBe(false);
  });
  it("rejects overflow through all parent refinements without throwing", () => {
    const selected = { ...unitSelection, quantity: 2147483647 };
    expect(shipmentLineFromPoSchema.safeParse({ purchaseOrderId: 1, lineSelections: [{ poLineId: 2, qty: 1, unitSelection: selected }] }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped: 1, unitSelection: selected }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 1, unitSelection: selected }).success).toBe(false);
  });
  it("preserves omitted legacy basis while rejecting explicit fallback to ambiguous null", () => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, qtyShipped: 1 }).success).toBe(true);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, dimensionBasis: null }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ sku: "EACH", qtyShipped: 1, dimensionBasis: null }).success).toBe(false);
  });
  it("requires explicit measurement meaning on a reviewed unit import", () => {
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 525000, unitSelection, weightKg: "1" }).success).toBe(false);
    expect(shipmentPackingListRowSchema.safeParse({ qtyShipped: 525000, unitSelection, weightKg: "1", dimensionBasis: "piece" }).success).toBe(true);
  });
  it("does not accept an unreviewed loose factor or server snapshot patch", () => {
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, unitsPerVariantSnapshot: 1000 }).success).toBe(false);
    expect(shipmentLinePatchSchema.safeParse({ expectedVersion: version, unitSelection: { ...unitSelection, arbitrary: true } }).success).toBe(false);
  });
});
describe("canonical shipment unit read evidence", () => {
  it("shows active product units without substituting live factor for the recorded factor", () => {
    const result = projectShipmentUnits({ productId: 1, selectedVariantId: 20, unitsPerVariantSnapshot: 500 }, [pack, piece]);
    expect(result.unitsPerVariantSnapshot).toBe(500);
    expect(result.variants.map((row) => row.unitsPerVariant)).toEqual([1, 1000]);
    expect(result.issue?.code).toBe("SHIPMENT_UNIT_SOURCE_CHANGED");
  });
  it("retains unknown legacy factor and never fabricates a one-piece unit", () => {
    const result = projectShipmentUnits({ productId: 1, selectedVariantId: 20, unitsPerVariantSnapshot: null }, [pack]);
    expect(result.unitsPerVariantSnapshot).toBeNull();
    expect(result.variants).toHaveLength(1);
  });
  it("excludes inactive or foreign variants and requires missing source review", () => {
    const result = projectShipmentUnits({ productId: 1, selectedVariantId: 20, unitsPerVariantSnapshot: 1000 }, [{ ...pack, isActive: false }, { ...piece, productId: 2 }]);
    expect(result.variants).toEqual([]);
    expect(result.issue?.code).toBe("SHIPMENT_UNIT_VARIANT_REVIEW_REQUIRED");
    expect(projectShipmentUnits({ productId: null, selectedVariantId: null, unitsPerVariantSnapshot: null }, [piece]).issue?.code).toBe("SHIPMENT_UNIT_PRODUCT_REQUIRED");
  });
  it("does not mutate source options", () => {
    const rows = [pack, piece]; const before = structuredClone(rows);
    projectShipmentUnits({ productId: 1, selectedVariantId: 20, unitsPerVariantSnapshot: 1000 }, rows);
    expect(rows).toEqual(before);
  });
});
