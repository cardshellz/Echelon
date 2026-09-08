import { describe, expect, it, vi } from "vitest";
import { planOperationalShipmentConsumption } from "../../domain/operational-shipment-dispatch";
import { AuthorityAwareInventoryShipmentRecorder } from "../../../inventory-planning/application/inventory-availability-runtime-shipment.service";
import { interpretInventoryShipmentQuantity } from "@shared/inventory/shipment-quantity";

const level = { id: 1, locationId: 10, onHand: 10, reserved: 4 };
const lots = [{ id: 2, onHand: 6, reserved: 3, unitCostMills: "103", receivedAt: new Date("2026-02-01") },
  { id: 1, onHand: 4, reserved: 1, unitCostMills: "107", receivedAt: new Date("2026-01-01") }];
const input = { productVariantId: 105, qty: 5, warehouseId: 1, orderId: 70,
  orderItemId: 71, shipmentId: 92, shipmentItemId: 103, userId: "worker" };
const evidence = () => ({
  transactionId: 1, transactionType: "ship", variantQtyDelta: -5, reservedQtyDelta: 0,
  referenceType: "operational_shipment", sourceState: "on_hand", targetState: "shipped",
  orderId: 70, orderItemId: null, shipmentId: 92, shipmentItemId: 103,
  productVariantId: 105, fromLocationId: 50, totalCostMills: "527", receipt: null,
  operationalReceipt: { id: "1", quantity: "5", orderId: 70, shipmentId: 92,
    shipmentItemId: 103, productVariantId: 105, fromLocationId: 50, warehouseId: 1,
    physicalShipmentItemId: null, purpose: "replacement", replacementForOrderItemId: 71,
    totalCostMills: "527", movementQuantity: "5", movementTotalCostMills: "527", invalidMovementCount: "0" },
});

describe("operational shipment exact domain and runtime", () => {
  it("plans stable FIFO by received date/id with exact mills and leaves inputs unchanged", () => {
    const before = structuredClone(lots);
    expect(planOperationalShipmentConsumption(5, level, lots)).toMatchObject({
      totalCostMills: "527", lots: [{ lotId: 1, quantity: 3, totalCostMills: "321" },
        { lotId: 2, quantity: 2, totalCostMills: "206" }],
    });
    expect(lots).toEqual(before);
  });
  it("does not promise stock from aggregate or lot reservations", () => {
    expect(planOperationalShipmentConsumption(7, level, lots)).toBeNull();
    expect(planOperationalShipmentConsumption(5, level, [{ ...lots[0], reserved: 5 }])).toBeNull();
  });
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER])("rejects invalid quantity %s", (quantity) => {
    expect(() => planOperationalShipmentConsumption(quantity, level, lots)).toThrow();
  });
  it("rejects duplicate lot identities", () => {
    expect(() => planOperationalShipmentConsumption(5, level, [lots[0], lots[0]]))
      .toThrow(/duplicate/);
  });
  it("preserves exact zero cost and rejects unknown or overflowing cost", () => {
    expect(planOperationalShipmentConsumption(1, level, [{ ...lots[0], unitCostMills: "0" }])?.totalCostMills).toBe("0");
    expect(() => planOperationalShipmentConsumption(1, level, [{ ...lots[0], unitCostMills: null as any }])).toThrow();
    expect(() => planOperationalShipmentConsumption(3, level, [{ ...lots[0], unitCostMills: "9223372036854775807" }])).toThrow(/boundary/);
  });
  it("routes canonical replacement identity to the operational owner without trusting caller warehouse/old order-item hints", async () => {
    const dispatch = vi.fn().mockResolvedValue({ warehouseLocationId: 50, alreadyRecorded: false, preserveSourceLocation: true });
    const customer = vi.fn();
    const recorder = new AuthorityAwareInventoryShipmentRecorder({
      execute: (work) => work({ authority: "canonical", dispatchSource: customer, dispatchOperationalSource: dispatch }),
    });
    await recorder.recordReplacementShipmentFromAvailableInventory(input);
    expect(dispatch).toHaveBeenCalledWith({ orderId: 70, outboundShipmentId: 92, sourceShipmentItemId: 103,
      productVariantId: 105, quantity: 5, actor: "worker" });
    expect(customer).not.toHaveBeenCalled();
  });
  it("routes concession flags only to a source-validating operational owner, never ordinary customer dispatch", async () => {
    const dispatch = vi.fn().mockResolvedValue({ warehouseLocationId: 50, alreadyRecorded: false, preserveSourceLocation: true });
    const customer = vi.fn();
    const recorder = new AuthorityAwareInventoryShipmentRecorder({
      execute: (work) => work({ authority: "canonical", dispatchSource: customer, dispatchOperationalSource: dispatch }),
    });
    await recorder.recordShipment({ productVariantId: 105, qty: 5, orderId: 70, shipmentId: "92",
      shipmentItemId: 103, warehouseLocationId: null, releaseReservation: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(customer).not.toHaveBeenCalled();
  });
  it("keeps legacy replacement on its existing guarded owner", async () => {
    const replacement = vi.fn().mockResolvedValue({ warehouseLocationId: 50, alreadyRecorded: true });
    const recorder = new AuthorityAwareInventoryShipmentRecorder({
      execute: (work) => work({ authority: "legacy", recordLegacy: vi.fn(), recordLegacyReplacement: replacement }),
    });
    expect(await recorder.recordReplacementShipmentFromAvailableInventory(input)).toEqual({ warehouseLocationId: 50, alreadyRecorded: true });
    expect(replacement).toHaveBeenCalledWith(input);
  });
  it("does not fall back to customer dispatch after operational failure", async () => {
    const customer = vi.fn();
    const recorder = new AuthorityAwareInventoryShipmentRecorder({
      execute: (work) => work({ authority: "canonical", dispatchSource: customer,
        dispatchOperationalSource: vi.fn().mockRejectedValue(new Error("source conflict")) }),
    });
    await expect(recorder.recordReplacementShipmentFromAvailableInventory(input)).rejects.toThrow("source conflict");
    expect(customer).not.toHaveBeenCalled();
  });
});

describe("operational shipment quantity proof", () => {
  it("requires its exact non-customer debit and FIFO cost receipt", () => {
    expect(interpretInventoryShipmentQuantity(evidence())).toEqual({ status: "verified", source: "operational_dispatch_receipt", quantity: 5, receiptId: "1" });
  });
  it.each([
    ["missing receipt", (row: any) => { row.operationalReceipt = null; }],
    ["lost marker", (row: any) => { row.referenceType = "shipment"; }],
    ["customer identity", (row: any) => { row.orderItemId = 71; }],
    ["zero debit", (row: any) => { row.variantQtyDelta = 0; }],
    ["picked debit", (row: any) => { row.sourceState = "picked"; }],
    ["reservation debit", (row: any) => { row.reservedQtyDelta = -1; }],
    ["cost mismatch", (row: any) => { row.operationalReceipt.movementTotalCostMills = "526"; }],
    ["quantity mismatch", (row: any) => { row.operationalReceipt.movementQuantity = "4"; }],
    ["mixed receipt", (row: any) => { row.receipt = {}; }],
    ["wrong source", (row: any) => { row.operationalReceipt.shipmentItemId = 999; }],
    ["concession ownership", (row: any) => { row.operationalReceipt.purpose = "concession"; }],
  ])("rejects %s without legacy fallback", (_name, mutate) => {
    const row = evidence(); mutate(row);
    expect(interpretInventoryShipmentQuantity(row)).toMatchObject({ status: "invalid" });
  });
});
