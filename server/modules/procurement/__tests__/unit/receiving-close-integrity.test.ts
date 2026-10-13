import { describe, expect, it } from "vitest";
import { assertReceivingLocations, resolveReceivingSources, type ReceiptPurchaseSource } from "../../receiving-close-integrity.domain";

const purchaseLine: ReceiptPurchaseSource = { id: 21, purchaseOrderId: 10, productId: 100, lineType: "product",
  status: "open", orderQty: 100, receivedQty: 0, cancelledQty: 0 };
const source = () => ({ receivingOrderId: 50, purchaseOrderId: 10 as number | null, inboundShipmentId: null as number | null,
  purchaseStatus: "sent" as string | null, shipmentStatus: null as string | null,
  lines: [{ id: 51, productId: 100, purchaseOrderLineId: null as number | null,
    inboundShipmentLineId: null as number | null, receivedQty: 2, damagedQty: 0 }],
  purchaseLines: [{ ...purchaseLine }], shipmentLines: [] as Array<{ id: number; inboundShipmentId: number; purchaseOrderId: number; purchaseOrderLineId: number }> });

describe("receiving source decisions before physical posting", () => {
  it("resolves a sole remaining product without mutating input", () => {
    const input = source(); const before = structuredClone(input);
    expect(resolveReceivingSources(input)).toEqual([{ receivingLineId: 51, purchaseOrderLineId: 21, inboundShipmentLineId: null }]);
    expect(input).toEqual(before);
  });
  it.each([0,2])("rejects %i possible product sources", (count) => {
    const input = source(); input.purchaseLines = Array.from({ length: count }, (_,i) => ({ ...purchaseLine, id: 21+i }));
    expect(() => resolveReceivingSources(input)).toThrow(expect.objectContaining({ details: expect.objectContaining({
      code: "RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED", issues: [expect.objectContaining({
        code: count ? "RECEIVING_SOURCE_AMBIGUOUS" : "RECEIVING_SOURCE_UNMATCHED", receivingLineId: 51 })] }) }));
  });
  it.each([null,"cancelled"])("rejects missing or cancelled purchase source %s", (status) => {
    expect(() => resolveReceivingSources({ ...source(), purchaseStatus: status })).toThrow(/purchase is missing or cancelled/);
  });
  it.each(["sent", "acknowledged", "partially_received", "received", "closed"])("preserves linked shipment source on purchase lifecycle %s", (status) => {
    const input = source(); input.purchaseStatus = status; input.inboundShipmentId = 1; input.shipmentStatus = "delivered";
    input.lines[0].purchaseOrderLineId = 21;
    input.shipmentLines = [{ id: 11, inboundShipmentId: 1, purchaseOrderId: 10, purchaseOrderLineId: 21 }];
    expect(resolveReceivingSources(input)[0].purchaseOrderLineId).toBe(21);
  });
  it.each(["cancelled","closed"])("rejects linked product source status %s", (status) => {
    const input = source(); input.lines[0].purchaseOrderLineId = 21; input.purchaseLines[0].status = status;
    expect(() => resolveReceivingSources(input)).toThrow(/current purchase product or source status/);
  });
  it("does not infer a fully received source but retains an explicit valid source", () => {
    const input = source(); input.purchaseLines[0].status = "received";
    expect(() => resolveReceivingSources(input)).toThrow(/no receivable purchase source/);
    input.lines[0].purchaseOrderLineId = 21;
    expect(resolveReceivingSources(input)[0].purchaseOrderLineId).toBe(21);
  });
  it.each(["product","purchase","type"])("rejects wrong %s on explicit source", (field) => {
    const input = source(); input.lines[0].purchaseOrderLineId = 21;
    if (field === "product") input.purchaseLines[0].productId = 101;
    if (field === "purchase") input.purchaseLines[0].purchaseOrderId = 11;
    if (field === "type") input.purchaseLines[0].lineType = "fee";
    expect(() => resolveReceivingSources(input)).toThrow(/current purchase product or source status/);
  });
  it("allows unlinked blind goods but rejects orphan PO or shipment references", () => {
    const input = { ...source(), purchaseOrderId: null };
    expect(resolveReceivingSources(input)).toEqual([]);
    input.lines[0].purchaseOrderLineId = 21;
    expect(() => resolveReceivingSources(input)).toThrow(/source is incomplete/);
  });
  it("resolves exact shipment lineage and rejects ambiguous shipment sources", () => {
    const input = source(); input.inboundShipmentId = 1; input.shipmentStatus = "delivered";
    input.shipmentLines = [{ id: 11, inboundShipmentId: 1, purchaseOrderId: 10, purchaseOrderLineId: 21 }];
    expect(resolveReceivingSources(input)[0].inboundShipmentLineId).toBe(11);
    input.shipmentLines.push({ ...input.shipmentLines[0], id: 12 });
    expect(() => resolveReceivingSources(input)).toThrow(/one exact shipment-line source/);
    input.lines[0].inboundShipmentLineId = 12;
    expect(resolveReceivingSources(input)[0].inboundShipmentLineId).toBe(12);
  });
  it("rejects cancelled shipment and ignores uncounted placeholder lines", () => {
    expect(() => resolveReceivingSources({ ...source(), inboundShipmentId: 1, shipmentStatus: "cancelled" })).toThrow(/shipment is unavailable/);
    const input = source(); input.purchaseLines = []; input.lines[0].receivedQty = 0;
    expect(resolveReceivingSources(input)).toEqual([]);
    input.lines[0].damagedQty = 1;
    expect(() => resolveReceivingSources(input)).toThrow(/no receivable purchase source/);
  });
});

describe("receiving warehouse and location decisions", () => {
  const input = () => ({ receivingOrderId: 50, warehouseId: 1 as number | null, warehouseActive: 1 as number | null,
    references: [{ receivingLineId: 51, locationId: 99 }], locations: [{ id: 99, warehouseId: 1, isActive: 1 }] });
  it("accepts active same-warehouse locations without mutating input", () => {
    const data = input(); const before = structuredClone(data);
    expect(() => assertReceivingLocations(data)).not.toThrow(); expect(data).toEqual(before);
  });
  it.each([null,0])("rejects missing/inactive warehouse %s", (active) => {
    expect(() => assertReceivingLocations({ ...input(), warehouseActive: active })).toThrow(/warehouse is missing or inactive/);
  });
  it("requires explicit warehouse and rejects missing/inactive/wrong-warehouse locations", () => {
    expect(() => assertReceivingLocations({ ...input(), warehouseId: null })).toThrow(/Select the receiving warehouse/);
    expect(() => assertReceivingLocations({ ...input(), locations: [] })).toThrow(/location is missing or inactive/);
    expect(() => assertReceivingLocations({ ...input(), locations: [{ id: 99, warehouseId: 1, isActive: 0 }] })).toThrow(/location is missing or inactive/);
    expect(() => assertReceivingLocations({ ...input(), warehouseId: 2 })).toThrow(expect.objectContaining({
      details: expect.objectContaining({ issues: [expect.objectContaining({ code: "RECEIVING_LOCATION_WAREHOUSE_MISMATCH", receivingLineId: 51, locationId: 99 })] }) }));
  });
});
