import { beforeAll, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { IInventoryStorage } from "../../infrastructure/inventory.repository";
import type { InventoryShipmentTransaction, RecordInventoryShipmentInput } from "../../application/inventory.use-cases";

let InventoryUseCases: typeof import("../../application/inventory.use-cases").InventoryUseCases;
beforeAll(async () => {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  ({ InventoryUseCases } = await import("../../application/inventory.use-cases"));
});

const command: RecordInventoryShipmentInput = {
  productVariantId: 30, warehouseLocationId: 20, qty: 2, orderId: 40,
  orderItemId: 50, shipmentId: "60", shipmentItemId: 70, userId: "test:shipment",
};
const validAuthority = { authority: "legacy", authority_revision: "1", activation_run_id: null };

function harness(rows: Record<string, unknown>[] = [validAuthority]) {
  const statements: string[] = [];
  const tx = {
    execute: vi.fn(async (query) => {
      const statement = new PgDialect().sqlToQuery(query).sql;
      statements.push(statement);
      return { rows: statement.includes("availability_runtime_authority") ? rows : [] };
    }),
  };
  const db = {
    select: vi.fn(), update: vi.fn(), insert: vi.fn(), execute: vi.fn(),
    transaction: vi.fn(async (work: (transaction: InventoryShipmentTransaction) => Promise<void>) =>
      work(tx as unknown as InventoryShipmentTransaction)),
  };
  const storage = {
    lockInventoryLevel: vi.fn(async () => ({ id: 10, variantQty: 5, reservedQty: 3, pickedQty: 2 })),
    adjustInventoryLevel: vi.fn(async () => null),
    createInventoryTransaction: vi.fn(async () => undefined),
  };
  const inventory = new InventoryUseCases(db, storage as unknown as IInventoryStorage);
  return { inventory, db, storage, tx, statements };
}

describe("legacy shipment authority ownership", () => {
  it.each([
    ["missing", []],
    ["unknown authority", [{ ...validAuthority, authority: "other" }]],
    ["zero revision", [{ ...validAuthority, authority_revision: "0" }]],
    ["missing revision", [{ authority: "legacy", activation_run_id: null }]],
    ["legacy activation lineage", [{ ...validAuthority, activation_run_id: "1" }]],
    ["canonical missing lineage", [{ ...validAuthority, authority: "canonical" }]],
    ["duplicate singleton", [validAuthority, validAuthority]],
  ])("fails closed before any legacy effects for %s", async (_name, rows) => {
    const { inventory, storage, statements } = harness(rows);
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "SHIPMENT_RUNTIME_AUTHORITY_INVALID" });
    expect(statements).toHaveLength(1);
    expect(storage.lockInventoryLevel).not.toHaveBeenCalled();
    expect(storage.adjustInventoryLevel).not.toHaveBeenCalled();
    expect(storage.createInventoryTransaction).not.toHaveBeenCalled();
  });

  it("rejects direct legacy posting under canonical authority even before replay", async () => {
    const { inventory, storage, statements } = harness([{ ...validAuthority, authority: "canonical", activation_run_id: "4" }]);
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "LEGACY_SHIPMENT_AUTHORITY_DISABLED" });
    expect(statements).toHaveLength(1);
    expect(storage.lockInventoryLevel).not.toHaveBeenCalled();
  });

  it("pins the authority first inside the caller transaction without opening another one", async () => {
    const { inventory, db, tx, storage, statements } = harness();
    await inventory.recordShipmentInsideTransaction(command, tx as unknown as InventoryShipmentTransaction);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(statements[0]).toContain("FOR SHARE");
    expect(statements[1]).toContain("pg_advisory_xact_lock");
    expect(storage.adjustInventoryLevel).toHaveBeenCalledWith(10, { pickedQty: -2 }, tx);
    expect(storage.createInventoryTransaction).toHaveBeenCalledWith(expect.objectContaining({ variantQtyDelta: -2 }), tx);
  });

  it("propagates a late unique violation instead of reporting an aborted transaction as success", async () => {
    const { inventory, storage } = harness();
    const duplicate = Object.assign(new Error("duplicate ship"), { code: "23505", constraint: "ship_item_dedup" });
    storage.createInventoryTransaction.mockRejectedValueOnce(duplicate);
    await expect(inventory.recordShipment(command)).rejects.toBe(duplicate);
    expect(storage.adjustInventoryLevel).toHaveBeenCalledOnce();
  });

  it.each([
    { qty: 0 }, { qty: 0.5 }, { qty: Number.NaN }, { qty: Number.MAX_SAFE_INTEGER },
    { productVariantId: -1 }, { orderId: 0 }, { warehouseLocationId: 0 }, { orderItemId: 0 },
    { shipmentItemId: 0 }, { shipmentId: "" }, { shipmentId: "2147483648" },
    { userId: " " }, { deductFromOnHandOnly: "true" }, { releaseReservation: 0 },
  ])("validates input before opening a transaction: %j", async (invalid) => {
    const { inventory, db } = harness();
    await expect(inventory.recordShipment({ ...command, ...invalid } as RecordInventoryShipmentInput))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["canonical", [{ ...validAuthority, authority: "canonical", activation_run_id: "4" }], "LEGACY_SHIPMENT_AUTHORITY_DISABLED"],
    ["missing", [], "SHIPMENT_RUNTIME_AUTHORITY_INVALID"],
  ])("does not allow replacement posting to bypass %s authority", async (_name, rows, code) => {
    const { inventory, storage, statements } = harness(rows);
    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30, qty: 2, warehouseId: 1, orderId: 40, shipmentId: 60, shipmentItemId: 70,
    })).rejects.toMatchObject({ code });
    expect(statements).toHaveLength(1);
    expect(storage.lockInventoryLevel).not.toHaveBeenCalled();
  });
});
