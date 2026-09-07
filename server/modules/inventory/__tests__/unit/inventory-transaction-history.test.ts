import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../db", () => ({ db: {} }));
import { createInventoryMethods } from "../../infrastructure/inventory.repository";

function harness(rows: Record<string, unknown>[], error?: Error) {
  const chain = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), offset: vi.fn(),
    then: (resolve: (value: Record<string, unknown>[]) => unknown, reject: (reason: Error) => unknown) =>
      (error ? Promise.reject(error) : Promise.resolve(rows)).then(resolve, reject) };
  for (const method of [chain.from, chain.where, chain.orderBy, chain.limit, chain.offset]) method.mockReturnValue(chain);
  const db = { select: vi.fn().mockReturnValue(chain) };
  return { db, chain, methods: createInventoryMethods(db as unknown as Parameters<typeof createInventoryMethods>[0]) };
}

function canonicalRow() {
  return { id: 1, transactionType: "ship", variantQtyDelta: 0, notes: "Preserved audit note",
    rawShipmentQuantityEvidence: { transactionId: 1, transactionType: "ship", variantQtyDelta: 0,
      reservedQtyDelta: 0, referenceType: "availability_claim_dispatch", sourceState: "picked", targetState: "shipped",
      orderId: 2, orderItemId: 3, shipmentId: 4, shipmentItemId: 5, productVariantId: 6, fromLocationId: 7,
      receipt: { id: "81", quantity: "3", orderId: 2, orderItemId: 3, shipmentId: 4, shipmentItemId: 5,
        productVariantId: 6, fromLocationId: 7, warehouseId: 8, physicalShipmentId: null, physicalShipmentItemId: null,
        movementQuantity: "3", invalidMovementCount: "0" } } };
}

describe("inventory transaction history quantity evidence", () => {
  it.each(["history", "variant"])("adds verified shipment evidence without changing ledger data in %s history", async (scope) => {
    const row = canonicalRow();
    const { db, methods } = harness([row]);
    const [result] = scope === "history" ? await methods.getInventoryTransactions({ transactionType: "ship", limit: 50 })
      : await methods.getInventoryTransactionsByProductVariantId(6, 50);
    expect(result).toMatchObject({ id: 1, variantQtyDelta: 0, notes: row.notes,
      shipmentQuantityEvidence: { status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "81" } });
    expect(result).not.toHaveProperty("rawShipmentQuantityEvidence");
    expect(row).not.toHaveProperty("shipmentQuantityEvidence");
    expect(db.select).toHaveBeenCalledTimes(1);
    const columns = db.select.mock.calls[0][0] as { rawShipmentQuantityEvidence: SQL };
    const projection = new PgDialect().sqlToQuery(columns.rawShipmentQuantityEvidence).sql;
    expect(projection).toContain("availability_claim_dispatch_receipts");
    expect(projection).toContain('"inventory"."inventory_transactions".id');
  });

  it("keeps corrupt shipment evidence inspectable instead of turning it into zero units", async () => {
    const row = canonicalRow();
    row.rawShipmentQuantityEvidence.receipt.quantity = "0";
    const { methods } = harness([row]);
    const [result] = await methods.getInventoryTransactions({});
    expect(result.variantQtyDelta).toBe(0);
    expect(result.shipmentQuantityEvidence).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
    expect(result.shipmentQuantityEvidence).not.toHaveProperty("quantity");
  });

  it("retains legacy debit semantics and non-shipment rows", async () => {
    const { methods } = harness([
      { id: 2, transactionType: "ship", variantQtyDelta: -5,
        rawShipmentQuantityEvidence: { transactionId: 2, transactionType: "ship", variantQtyDelta: -5, referenceType: "order", receipt: null } },
      { id: 3, transactionType: "pick", variantQtyDelta: -3,
        rawShipmentQuantityEvidence: { transactionId: 3, transactionType: "pick", variantQtyDelta: -3, receipt: null } },
    ]);
    const result = await methods.getInventoryTransactions({});
    expect(result[0]).toMatchObject({ variantQtyDelta: -5, shipmentQuantityEvidence: {
      status: "verified", quantity: 5, source: "legacy_on_hand_delta", receiptId: null } });
    expect(result[1]).toMatchObject({ variantQtyDelta: -3, shipmentQuantityEvidence: { status: "not_shipment" } });
  });

  it("propagates a failed read rather than returning fabricated empty history", async () => {
    const { methods } = harness([], new Error("snapshot unavailable"));
    await expect(methods.getInventoryTransactions({})).rejects.toThrow("snapshot unavailable");
  });
});
