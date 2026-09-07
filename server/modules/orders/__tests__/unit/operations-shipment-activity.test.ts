import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../warehouse/settings.resolver", () => ({ getSettingsForWarehouse: vi.fn() }));
import { OperationsDashboardService } from "../../operations-dashboard.service";

const canonicalEvidence = () => ({ transactionId: 1, transactionType: "ship", variantQtyDelta: 0,
  reservedQtyDelta: 0, referenceType: "availability_claim_dispatch", sourceState: "picked", targetState: "shipped",
  orderId: 2, orderItemId: 3, shipmentId: 4, shipmentItemId: 5, productVariantId: 6, fromLocationId: 7,
  receipt: { id: "81", quantity: "3", orderId: 2, orderItemId: 3, shipmentId: 4, shipmentItemId: 5,
    productVariantId: 6, fromLocationId: 7, warehouseId: 8, physicalShipmentId: null, physicalShipmentItemId: null,
    movementQuantity: "3", invalidMovementCount: "0" } });

describe("operations shipment activity", () => {
  it("projects the exact canonical quantity in one read while preserving zero on-hand delta", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, transaction_type: "ship", variant_qty_delta: 0,
      shipment_quantity_evidence: canonicalEvidence() }] }) };
    const result = await new OperationsDashboardService(db).getActivity({ variantId: 6 });
    expect(result[0]).toMatchObject({ variantQtyDelta: 0, shipmentQuantityEvidence: {
      status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "81" } });
    expect(db.execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0]);
    expect(query.sql).toContain("availability_claim_dispatch_receipts");
    expect(query.sql).toContain("shipment_quantity_evidence");
    expect(query.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });

  it("returns malformed canonical evidence as explicit invalid state, never zero shipped", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 1, transaction_type: "ship", variant_qty_delta: 0,
      shipment_quantity_evidence: { ...canonicalEvidence(), receipt: null } }] }) };
    const [result] = await new OperationsDashboardService(db).getActivity({});
    expect(result.shipmentQuantityEvidence).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
    expect(result.shipmentQuantityEvidence).not.toHaveProperty("quantity");
    expect(result.variantQtyDelta).toBe(0);
  });

  it("preserves the bin-scoped shipment exclusion and parameterized location filter", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    await new OperationsDashboardService(db).getActivity({ locationId: 7 });
    const query = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0]);
    expect(query.sql).toContain("it.transaction_type != 'ship'");
    expect(query.params).toContain(7);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
