import { describe, expect, it } from "vitest";
import { planSupplierReturnQuantity, proveSupplierReturnProvenance, type SupplierReturnOriginEvidence, type SupplierReturnProvenanceLot, type SupplierReturnTransferEvidence } from "../../domain/supplier-return-stock";
import { verifySupplierReturnCostHistory } from "../../domain/supplier-return-cost";
import { lotCostsForIntervals } from "../../domain/lot-cost";
import { normalizeQuantityCommand, applyQuantityDelta, type QuantityCommand } from "../../domain/quantity-ledger";

const rootLot: SupplierReturnProvenanceLot = {
  id: 10, productId: 1, productVariantId: 2, receivedQuantity: 100,
  purchaseOrderId: 3, purchaseOrderLineId: 4, receivingOrderId: 5,
};
function origin(): SupplierReturnOriginEvidence {
  return { origin: {
    inventoryLotId: 10, productId: 1, productVariantId: 2, vendorId: 6, purchaseOrderId: 3, purchaseOrderLineId: 4,
    receivingOrderId: 5, receivingLineId: 7, unitsPerVariant: 5, receivedVariantQuantity: 100,
    purchaseStartBasePiece: 0, inboundShipmentLineId: null, shipmentStartBasePiece: null,
  }, receipt: {
    receivingOrderId: 5, purchaseOrderLineId: 4, productId: 1, productVariantId: 2, unitsPerVariant: 5,
    receivedQuantity: 100, recordedOriginQuantity: 100, closed: true, hasReversal: false, costSourceKind: "purchase_order_line",
  } };
}
function transferred(): SupplierReturnTransferEvidence {
  return { transfer: { contributionId: 20, sourceLotId: 10, outputLotId: 11, sourceQuantity: 30, outputQuantity: 30,
    outputStartQuantity: 0, allocationId: 40, intervals: [{ start: 0, quantity: 30 }] },
  operationKind: "transfer", allocationLotId: 10, allocationQuantity: 30, allocationDirection: 1, hasAllocationReversal: false };
}
const exactLot = { id: 10, qty_received: 100, cost_basis_qty: 100,
  product_total_cost_mills: 10000, packaging_total_cost_mills: 1000, landed_total_cost_mills: 500 };
function quantity() {
  return { lot: exactLot, quantity: 20, onHand: 80, reserved: 10, basisQuantity: 100,
    freeIntervals: [{ start: 20, quantity: 80 }], hasUnresolvedQuantity: false };
}

describe("source-proven accepted supplier stock returns", () => {
  it("proves original frozen receipt identity without changing historical quantities", () => {
    const input = { inventoryLotId: 10, vendorId: 6, lots: [rootLot], origins: [origin()], transfers: [] };
    const unchanged = structuredClone(input);
    expect(proveSupplierReturnProvenance(input)).toEqual({ contractVersion: 1, origin: origin().origin, transfers: [] });
    expect(input).toEqual(unchanged);
  });
  it("follows a complete one-to-one transfer chain in root-to-selected order", () => {
    const child = { ...rootLot, id: 11, receivedQuantity: 30 };
    expect(proveSupplierReturnProvenance({ inventoryLotId: 11, vendorId: 6, lots: [rootLot, child], origins: [origin()], transfers: [transferred()] }))
      .toMatchObject({ origin: { inventoryLotId: 10, unitsPerVariant: 5 }, transfers: [{ contributionId: 20, allocationId: 40 }] });
  });
  it.each([
    { operationKind: "conversion" }, { operationKind: "build" }, { allocationDirection: -1 },
    { allocationLotId: 999 }, { allocationQuantity: 29 }, { hasAllocationReversal: true },
  ])("rejects unsupported or conflicting transferred custody %j", change => {
    expect(() => proveSupplierReturnProvenance({ inventoryLotId: 11, vendorId: 6,
      lots: [rootLot, { ...rootLot, id: 11, receivedQuantity: 30 }], origins: [origin()], transfers: [{ ...transferred(), ...change }] })).toThrow();
  });
  it.each([
    { closed: false }, { hasReversal: true }, { unitsPerVariant: 1 }, { productVariantId: 3 },
    { productId: 2 }, { purchaseOrderLineId: 5 }, { receivedQuantity: 90 }, { recordedOriginQuantity: 99 },
    { costSourceKind: "manual" },
  ])("rejects changed original receipt evidence %j", change => {
    const evidence = origin(); Object.assign(evidence.receipt, change);
    expect(() => proveSupplierReturnProvenance({ inventoryLotId: 10, vendorId: 6, lots: [rootLot], origins: [evidence], transfers: [] })).toThrow();
  });
  it("rejects another supplier, duplicate roots, mixed incoming sources and missing provenance", () => {
    const base = { inventoryLotId: 10, vendorId: 6, lots: [rootLot], origins: [origin()], transfers: [] };
    expect(() => proveSupplierReturnProvenance({ ...base, vendorId: 8 })).toThrow(/different supplier/);
    expect(() => proveSupplierReturnProvenance({ ...base, origins: [origin(), origin()] })).toThrow(/duplicate/);
    expect(() => proveSupplierReturnProvenance({ ...base, origins: [] })).toThrow(/missing or mixed/);
    expect(() => proveSupplierReturnProvenance({ ...base, inventoryLotId: 11, lots: [rootLot, { ...rootLot, id: 11, receivedQuantity: 30 }],
      transfers: [transferred(), { ...transferred(), transfer: { ...transferred().transfer, contributionId: 21 } }] })).toThrow(/missing or mixed/);
  });
  it("rejects copied source labels that disagree with the immutable origin", () => {
    for (const changed of [{ purchaseOrderId: 999 }, { receivingOrderId: null }, { productVariantId: 99 }]) {
      expect(() => proveSupplierReturnProvenance({ inventoryLotId: 10, vendorId: 6,
        lots: [{ ...rootLot, ...changed }], origins: [origin()], transfers: [] })).toThrow();
    }
  });
  it("consumes only the selected unreserved interval and keeps all three exact component values", () => {
    const input = quantity(), before = structuredClone(input);
    expect(planSupplierReturnQuantity(input)).toEqual({
      availableQuantity: 70, intervals: [{ start: 20, quantity: 20 }],
      costs: { productMills: 2000, packagingMills: 200, landedMills: 100, totalMills: 2300 },
    });
    expect(input).toEqual(before);
  });
  it.each([0, -1, 0.5, 2147483648, Number.NaN, Number.POSITIVE_INFINITY])("rejects unsupported quantity %s", requested => {
    expect(() => planSupplierReturnQuantity({ ...quantity(), quantity: requested })).toThrow();
  });
  it("rejects reservations, unresolved history, absent exact basis and quantity drift", () => {
    for (const change of [{ quantity: 71 }, { basisQuantity: null }, { hasUnresolvedQuantity: true },
      { onHand: 79 }, { reserved: 81 }, { lot: { ...exactLot, cost_basis_qty: null } }]) {
      expect(() => planSupplierReturnQuantity({ ...quantity(), ...change })).toThrow();
    }
  });
  it("preserves sub-cent intervals and conserves late cost across on-hand, sold and returned quantities", () => {
    const lot = { ...exactLot, qty_received: 3, cost_basis_qty: 3, product_total_cost_mills: 7, packaging_total_cost_mills: 0, landed_total_cost_mills: 0 };
    const returned = planSupplierReturnQuantity({ lot, quantity: 1, onHand: 2, reserved: 0, basisQuantity: 3,
      freeIntervals: [{ start: 1, quantity: 2 }], hasUnresolvedQuantity: false });
    expect(returned.costs.totalMills).toBe(2);
    const later = { ...lot, product_total_cost_mills: 11, landed_total_cost_mills: 7 };
    const sold = lotCostsForIntervals(later, [{ start: 0, quantity: 1 }]);
    const supplier = lotCostsForIntervals(later, returned.intervals);
    const remaining = lotCostsForIntervals(later, [{ start: 2, quantity: 1 }]);
    expect(sold.totalMills + supplier.totalMills + remaining.totalMills).toBe(BigInt(18));
    expect(supplier.totalMills).toBe(BigInt(6));
    expect(later.cost_basis_qty).toBe(3);
  });
  it("supports exact confirmed zero without inventing a loss or positive unit rate", () => {
    expect(planSupplierReturnQuantity({ ...quantity(), lot: { ...exactLot,
      product_total_cost_mills: 0, packaging_total_cost_mills: 0, landed_total_cost_mills: 0 } }).costs.totalMills).toBe(0);
  });
});

describe("supplier return value ledger", () => {
  const costs = { productMills: 2000, packagingMills: 200, landedMills: 100, totalMills: 2300 };
  const initial = ["product", "packaging", "landed"].map((component, index) => ({
    id: index + 1, returnAllocationId: 1, component, previousMills: 0, nextMills: [2000, 200, 100][index],
    deltaMills: [2000, 200, 100][index], postingKey: "initial", reason: "Supplier collected goods", sourceRevisionId: null,
    applicationId: null, recordedBy: "operator", recordedAt: "2026-10-20T14:00:00.000Z",
  }));
  it("preserves initial amounts and chains independent late price and freight adjustments", () => {
    const history = verifySupplierReturnCostHistory(1, costs, [...initial,
      { ...initial[0], id: 4, previousMills: 2000, nextMills: 1800, deltaMills: -200, postingKey: "price", sourceRevisionId: 5 },
      { ...initial[2], id: 5, previousMills: 100, nextMills: 150, deltaMills: 50, postingKey: "freight", sourceRevisionId: 6 }]);
    expect(history.initialCostEntryIds).toEqual({ product: 1, packaging: 2, landed: 3 });
    expect(history.currentCosts).toEqual({ productMills: 1800, packagingMills: 200, landedMills: 150, totalMills: 2150 });
    expect(initial[0].nextMills).toBe(2000);
  });
  it("rejects missing, duplicated, discontinuous and foreign value evidence", () => {
    for (const entries of [initial.slice(1), [...initial, initial[0]],
      [...initial, { ...initial[0], id: 4, previousMills: 1999, nextMills: 2000, deltaMills: 1, postingKey: "changed" }],
      initial.map(entry => ({ ...entry, returnAllocationId: 2 }))]) {
      expect(() => verifySupplierReturnCostHistory(1, costs, entries)).toThrow();
    }
  });
});

describe("supplier returns have explicit outbound quantity semantics", () => {
  const command = (onHand: number, reserved = 0): QuantityCommand => ({
    contractVersion: "inventory_quantity_v1", idempotencyKey: "supplier-return-1", kind: "supplier_return", actor: "operator",
    reason: "Supplier collected stock", occurredAt: "2026-10-20T14:00:00Z", reference: { type: "supplier_return", id: "1" }, reversesCommandId: null,
    movements: [{ inventoryLotId: 1, inventoryLevelId: 2, warehouseId: 3, warehouseLocationId: 4, productVariantId: 5,
      delta: { onHand, reserved, picked: 0, packed: 0 } }],
  });
  it("reduces only unreserved on-hand and leaves picked/packed custody alone", () => {
    const normalized = normalizeQuantityCommand(command(-4));
    expect(applyQuantityDelta({ onHand: 10, reserved: 6, picked: 3, packed: 2 }, normalized.movements[0]))
      .toEqual({ onHand: 6, reserved: 6, picked: 3, packed: 2 });
    expect(() => applyQuantityDelta({ onHand: 9, reserved: 6, picked: 3, packed: 2 }, normalized.movements[0])).toThrow();
  });
  it.each([[1, 0], [0, 0], [-1, -1], [-1, 1]])("rejects inbound or reservation-releasing return %j", (onHand, reserved) => {
    expect(() => normalizeQuantityCommand(command(onHand, reserved))).toThrow();
  });
});
