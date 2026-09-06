import { describe, expect, it } from "vitest";
import {
  SHIPMENT_COST_ALLOCATION_METHODS,
  SHIPMENT_COST_TYPES,
  shipmentCostCreateSchema,
  shipmentCostDeleteSchema,
  shipmentCostPatchSchema,
} from "../../procurement/shipment-cost-command";
import {
  SHIPMENT_HEADER_MODES,
  shipmentHeaderCreateSchema,
  shipmentHeaderPatchSchema,
} from "../../procurement/shipment-header-input";

const expectedVersion = "a1".repeat(32);

describe("shipment cost command boundary", () => {
  it("preserves unknown, zero, signed credit and exact safe-integer amounts", () => {
    for (const amount of [null, 0, -5500, 12345, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect(shipmentCostCreateSchema.parse({ costType: "other", actualCents: amount }).actualCents).toBe(amount);
    }
    expect(shipmentCostCreateSchema.parse({ costType: "freight" })).not.toHaveProperty("actualCents");
  });

  it.each(["100", "", false, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe/coerced cents %s", (amount) => {
    expect(shipmentCostCreateSchema.safeParse({ costType: "freight", actualCents: amount }).success).toBe(false);
    expect(shipmentCostPatchSchema.safeParse({ expectedVersion, estimatedCents: amount }).success).toBe(false);
  });

  it("accepts all existing cost types and allocation methods", () => {
    for (const costType of SHIPMENT_COST_TYPES) expect(shipmentCostCreateSchema.safeParse({ costType }).success).toBe(true);
    for (const allocationMethod of [...SHIPMENT_COST_ALLOCATION_METHODS, null]) {
      expect(shipmentCostPatchSchema.safeParse({ expectedVersion, allocationMethod }).success).toBe(true);
    }
  });

  it.each([
    { costType: "invented" }, { allocationMethod: "default" }, { allocationMethod: "invented" },
    { currency: "EUR" }, { currency: "usd" }, { currency: null },
    { exchangeRate: "1.0000" }, { exchangeRate: 1 }, { exchangeRate: "1.2" },
  ])("rejects unsupported enum and FX input %j", (fields) => {
    expect(shipmentCostCreateSchema.safeParse({ costType: "freight", ...fields }).success).toBe(false);
  });

  it("accepts explicit USD/one without injecting currency or amount defaults", () => {
    expect(shipmentCostCreateSchema.parse({ costType: "freight", currency: "USD", exchangeRate: "1" })).toEqual({
      costType: "freight", currency: "USD", exchangeRate: "1",
    });
  });

  it.each([
    "id", "inboundShipmentId", "vendorInvoiceId", "invoiceNumber", "costStatus",
    "dueDate", "paidDate", "createdBy", "updatedBy", "createdAt", "updatedAt",
    "allocatedCostCents", "vendorName", "unknownField",
  ])("rejects owner/AP fields instead of silently dropping %s", (field) => {
    expect(shipmentCostCreateSchema.safeParse({ costType: "freight", [field]: null }).success).toBe(false);
    expect(shipmentCostPatchSchema.safeParse({ expectedVersion, notes: "Amendment", [field]: null }).success).toBe(false);
  });

  it.each([undefined, null, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64)])("requires the exact lowercase version token %s", (version) => {
    expect(shipmentCostPatchSchema.safeParse({ expectedVersion: version, notes: "Updated" }).success).toBe(false);
    expect(shipmentCostDeleteSchema.safeParse({ expectedVersion: version }).success).toBe(false);
  });

  it("rejects empty amendments and does not treat reason as a cost edit", () => {
    for (const input of [{ expectedVersion }, { expectedVersion, reason: "Explained" }, { expectedVersion, notes: undefined }]) {
      expect(shipmentCostPatchSchema.safeParse(input).success).toBe(false);
    }
    expect(shipmentCostPatchSchema.parse({ expectedVersion, notes: null })).toEqual({ expectedVersion, notes: null });
    expect(shipmentCostDeleteSchema.parse({ expectedVersion, reason: "  Duplicate  " })).toEqual({ expectedVersion, reason: "Duplicate" });
    expect(shipmentCostDeleteSchema.safeParse({ expectedVersion, actualCents: 0 }).success).toBe(false);
    expect(shipmentCostDeleteSchema.safeParse({ expectedVersion, reason: "  " }).success).toBe(false);
  });

  it("accepts valid recorded dates without changing the supplied instant or mutating input", () => {
    const command = Object.freeze({ costType: "freight", invoiceDate: "2026-09-06T00:00:00-04:00", vendorId: 12, description: "" });
    expect(shipmentCostCreateSchema.parse(command)).toEqual(command);
    expect(shipmentCostPatchSchema.parse({ expectedVersion, invoiceDate: null }).invoiceDate).toBeNull();
    expect(shipmentCostCreateSchema.safeParse({ costType: "other", invoiceDate: "2024-02-29" }).success).toBe(true);
  });

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-09-06T00:00:00", "yesterday", ""])("rejects invalid or timezone-ambiguous cost date %s", (invoiceDate) => {
    expect(shipmentCostCreateSchema.safeParse({ costType: "freight", invoiceDate }).success).toBe(false);
  });

  it.each([0, -1, 1.5, "12", Number.MAX_SAFE_INTEGER, 2_147_483_648])("rejects non-database vendor ID %s", (vendorId) => {
    expect(shipmentCostCreateSchema.safeParse({ costType: "freight", vendorId }).success).toBe(false);
  });
});

describe("shipment header input boundary", () => {
  it("accepts the actual PO and list create payloads without server-owned defaults", () => {
    expect(shipmentHeaderCreateSchema.parse({ mode: "sea_fcl", shipmentNumber: "S-123", shipperName: "Vendor", forwarderName: "", carrierName: "Carrier" })).toEqual({
      mode: "sea_fcl", shipmentNumber: "S-123", shipperName: "Vendor", forwarderName: "", carrierName: "Carrier",
    });
    expect(shipmentHeaderCreateSchema.parse({ mode: "ground", warehouseId: 2, eta: "2026-10-10", notes: "" })).toEqual({
      mode: "ground", warehouseId: 2, eta: "2026-10-10", notes: "",
    });
    expect(shipmentHeaderCreateSchema.parse({})).toEqual({});
  });

  it("preserves all existing mode names and explicit empty/null editable fields", () => {
    for (const mode of [...SHIPMENT_HEADER_MODES, "", null]) {
      expect(shipmentHeaderPatchSchema.parse({ mode })).toEqual({ mode });
    }
    expect(shipmentHeaderPatchSchema.parse({ etd: null, eta: "2026-09-06T10:00:00Z", grossWeightKg: null, notes: "" })).toEqual({
      etd: null, eta: "2026-09-06T10:00:00Z", grossWeightKg: null, notes: "",
    });
  });

  it.each([
    "id", "status", "createdBy", "closedBy", "closedAt", "createdAt", "updatedAt",
    "estimatedTotalCostCents", "actualTotalCostCents", "totalWeightKg", "totalVolumeCbm",
    "totalPieces", "totalCartons", "allocationMethodDefault", "shipDate", "actualArrival",
    "customsClearedDate", "deliveredDate", "purchaseOrderId", "unknownField",
  ])("rejects server-owned header field %s", (field) => {
    expect(shipmentHeaderCreateSchema.safeParse({ [field]: null }).success).toBe(false);
    expect(shipmentHeaderPatchSchema.safeParse({ notes: "Allowed", [field]: null }).success).toBe(false);
  });

  it("rejects number changes through PATCH and empty edits", () => {
    expect(shipmentHeaderPatchSchema.safeParse({ shipmentNumber: "Replacement" }).success).toBe(false);
    expect(shipmentHeaderPatchSchema.safeParse({}).success).toBe(false);
    expect(shipmentHeaderPatchSchema.safeParse({ notes: undefined }).success).toBe(false);
    expect(shipmentHeaderCreateSchema.safeParse({ shipmentNumber: "   " }).success).toBe(false);
  });

  it("checks the existing database precision without converting decimal strings", () => {
    const input = Object.freeze({ containerCapacityCbm: "999999.99", grossWeightKg: "999999999.999", totalGrossVolumeCbm: "999999.999999", palletCount: 0 });
    expect(shipmentHeaderPatchSchema.parse(input)).toEqual(input);
    for (const value of ["1000000000", "0.0001", "-1", "1e2", "NaN", "Infinity", "", 1]) {
      expect(shipmentHeaderPatchSchema.safeParse({ grossWeightKg: value }).success).toBe(false);
    }
    expect(shipmentHeaderPatchSchema.safeParse({ totalGrossVolumeCbm: "1000000" }).success).toBe(false);
    expect(shipmentHeaderPatchSchema.safeParse({ containerCapacityCbm: "1.001" }).success).toBe(false);
  });

  it.each([
    { carrierName: "x".repeat(101) }, { shipmentNumber: "x".repeat(31) },
    { warehouseId: "2" }, { warehouseId: 0 }, { warehouseId: 2_147_483_648 },
    { palletCount: -1 }, { palletCount: 1.5 }, { palletCount: 2_147_483_648 },
    { eta: "2026-02-30" }, { etd: "" }, { mode: "teleport" },
  ])("rejects malformed header values %j", (input) => {
    expect(shipmentHeaderCreateSchema.safeParse(input).success).toBe(false);
  });
});
