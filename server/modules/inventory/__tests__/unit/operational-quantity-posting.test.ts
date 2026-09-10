import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { openOperationalQuantityPosting, OperationalQuantityPosting, quantityTransactionFromDrizzle } from "../../infrastructure/operational-quantity-posting";
import type { InventoryQuantityTransaction } from "../../application/quantity-ledger.port";

const dialect = new PgDialect();

describe("operational quantity posting boundary", () => {
  it("keeps PostgreSQL arrays and unsafe text as individual bound parameters", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = quantityTransactionFromDrizzle({ execute: async query => {
      const compiled = dialect.sqlToQuery(query); statements.push({ sql: compiled.sql, params: compiled.params }); return { rows: [] };
    } });
    const value = "'; DELETE FROM inventory.inventory_lots; --";
    await client.query("SELECT id WHERE id = ANY($1::integer[]) AND note = $2 OR alternate = $2", [[2, 5], value]);
    expect(statements).toEqual([{ sql: "SELECT id WHERE id = ANY($1::integer[]) AND note = $2 OR alternate = $3", params: [[2, 5], value, value] }]);
  });

  it("does not treat missing schema as permission for legacy writes", async () => {
    await expect(openOperationalQuantityPosting({ execute: async () => { throw Object.assign(new Error("missing opening schema"), { code: "42P01" }); } }))
      .rejects.toMatchObject({ code: "42P01" });
  });

  it("returns inactive only when the fence exists and no opening exists", async () => {
    const execute = vi.fn(async query => ({ rows: dialect.sqlToQuery(query).sql.includes("admission_fence") ? [{ epoch: 1 }] : [] }));
    expect(await openOperationalQuantityPosting({ execute })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects autocommit before any operational lot or receipt can be created", async () => {
    const statements: string[] = [];
    const execute = vi.fn(async query => {
      const text = dialect.sqlToQuery(query).sql; statements.push(text);
      if (text.startsWith("SAVEPOINT")) throw Object.assign(new Error("SAVEPOINT can only be used in transaction blocks"), { code: "25P01" });
      return { rows: text.includes("admission_fence") ? [{ epoch: 1 }] : [{ command_id: 1 }] };
    });
    await expect(openOperationalQuantityPosting({ execute })).rejects.toMatchObject({ code: "25P01" });
    expect(statements.some(text => /INSERT|UPDATE|DELETE/.test(text))).toBe(false);
  });

  it("requires a stable owner key before physical planning", async () => {
    const client: InventoryQuantityTransaction = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(new OperationalQuantityPosting(client).beginOperation(undefined, { quantity: 2 }))
      .rejects.toMatchObject({ code: "QUANTITY_COMMAND_KEY_REQUIRED" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects conflicting reuse before a second FIFO plan", async () => {
    const client: InventoryQuantityTransaction = { query: vi.fn(async text => ({ rows: text.includes("quantity_operation_receipts")
      ? [{ request_hash: "0".repeat(64), result: { quantity: 2 } }] : [] })) };
    await expect(new OperationalQuantityPosting(client).beginOperation("transfer:1", { quantity: 3 }))
      .rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects whitespace aliases before a different owner lock can be acquired", async () => {
    const client: InventoryQuantityTransaction = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(new OperationalQuantityPosting(client).beginOperation(" transfer:1 ", { quantity: 2 }))
      .rejects.toMatchObject({ code: "QUANTITY_COMMAND_KEY_INVALID" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("records an empty inspected operation exactly once without a physical command", async () => {
    const client: InventoryQuantityTransaction = { query: vi.fn(async () => ({ rows: [] })) };
    const posting = new OperationalQuantityPosting(client);
    await posting.beginOperation("empty-operation:1", { sourceProductId: 20 });
    await posting.finishNoMovement({ transferred: 0 });
    const calls = vi.mocked(client.query).mock.calls;
    expect(calls.some(([text]) => text.includes("'no_movement'"))).toBe(true);
    expect(calls.some(([text]) => text.includes("quantity_commands"))).toBe(false);
    await expect(posting.finishNoMovement({ transferred: 0 })).rejects.toMatchObject({ code: "QUANTITY_OPERATION_CLOSED" });
  });

  it("does not label staged physical changes as no movement", async () => {
    const client: InventoryQuantityTransaction = { query: vi.fn(async text => ({ rows: text.includes('AS "inventoryLotId"')
      ? [{ inventoryLotId: 1, inventoryLevelId: 2, productVariantId: 3, warehouseLocationId: 4, warehouseId: 5 }] : [] })) };
    const posting = new OperationalQuantityPosting(client);
    await posting.beginOperation("not-empty:1", { quantity: 1 });
    await posting.addLot(1, { onHand: 1, reserved: 0, picked: 0, packed: 0 });
    await expect(posting.finishNoMovement({ transferred: 0 })).rejects.toMatchObject({ code: "QUANTITY_NO_MOVEMENT_INVALID" });
  });
});
