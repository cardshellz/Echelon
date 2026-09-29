import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { combinedOrderGroups } from "@shared/schema";

vi.mock("../../shipment-rollup", () => ({ recomputeOrderStatusFromShipments: vi.fn() }));
import { createOrderCombiningService } from "../../combining.service";

function selectable(rows: unknown[], locks: string[]) {
  const query = Object.assign(Promise.resolve(rows), {
    from: (_table: unknown) => query,
    where: (_condition: unknown) => query,
    limit: (_limit: number) => query,
    orderBy: (_column: unknown) => query,
    for: (lock: string) => { locks.push(lock); return query; },
  });
  return query;
}

class CombiningDb {
  readonly locks: string[] = [];
  readonly reads: unknown[][] = [];
  readonly inserted: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  rawOrders: unknown[] = [];
  readonly select = vi.fn(() => selectable(this.reads.shift() ?? [], this.locks));
  readonly execute = vi.fn(async (_query: SQL) => ({ rows: this.rawOrders }));
  readonly insert = vi.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      this.inserted.push({ table, value });
      return { returning: async () => [{ id: 50, ...value }] };
    },
  }));
  readonly update = vi.fn((_table: unknown) => ({
    set: (_value: unknown) => ({ where: async (_condition: unknown) => [] }),
  }));
  readonly delete = vi.fn((_table: unknown) => ({ where: async (_condition: unknown) => [] }));
  transactions = 0;
  async transaction<T>(work: (tx: CombiningDb) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return work(this);
  }
}

function order(id: number, country: string | null, groupId: number | null = null) {
  return { id, orderNumber: `TEST-${id}`, warehouseId: 1, warehouseStatus: "ready", onHold: 0,
    customerName: "Test", customerEmail: "test@example.invalid", shippingAddress: "1 Main Street",
    shippingCity: "Test City", shippingState: "Test Region", shippingPostalCode: "10001",
    shippingCountry: country, combinedGroupId: groupId, combinedRole: null,
    orderPlacedAt: "2026-09-01T00:00:00Z", itemCount: 1, unitCount: 1 };
}

function rawOrder(id: number, country: string | null) {
  return { id, order_number: `TEST-${id}`, warehouse_id: 1, warehouse_status: "ready", on_hold: 0,
    customer_name: "Test", customer_email: "test@example.invalid", shipping_address: "1 Main Street",
    shipping_city: "Test City", shipping_state: "Test Region", shipping_postal_code: "10001",
    shipping_country: country, combined_group_id: null, item_count: 1, unit_count: 1 };
}

function expectNoWrites(db: CombiningDb) {
  expect(db.insert).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
  expect(db.delete).not.toHaveBeenCalled();
}

describe("country integrity when combining orders", () => {
  it("does not suggest combining otherwise identical addresses in different countries", async () => {
    const db = new CombiningDb();
    db.rawOrders = [rawOrder(1, "US"), rawOrder(2, "CA")];
    expect(await createOrderCombiningService(db).getCombinableGroups()).toEqual([]);
    expectNoWrites(db);
  });

  it("groups equivalent aliases using canonical country and excludes unknown destinations", async () => {
    const db = new CombiningDb();
    db.rawOrders = [rawOrder(1, "UK"), rawOrder(2, "United Kingdom"), rawOrder(3, "XX"),
      rawOrder(4, "XX"), rawOrder(5, null), rawOrder(6, null)];
    db.reads.push([{ enableOrderCombining: 1 }]);
    const groups = await createOrderCombiningService(db).getCombinableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].shippingCountry).toBe("GB");
    expect(groups[0].addressHash).toMatch(/^[a-f0-9]{64}$/);
    expect(groups[0].orders.map(row => row.id)).toEqual([1, 2]);
  });

  it.each(["CA", "XX", null])("rejects incompatible manual country %s before mutation", async country => {
    const db = new CombiningDb();
    db.reads.push([order(1, "US"), order(2, country)]);
    await expect(createOrderCombiningService(db).combineOrders([1, 2], "staff-test"))
      .rejects.toMatchObject({ name: "CombineError", statusCode: 400 });
    expect(db.transactions).toBe(1);
    expect(db.locks).toEqual(["update"]);
    expectNoWrites(db);
  });

  it("writes canonical manual group country without altering the original order objects", async () => {
    const db = new CombiningDb();
    const source = [order(1, "UK"), order(2, "United Kingdom")];
    db.reads.push(source, [{ enableOrderCombining: 1 }], []);
    const result = await createOrderCombiningService(db).combineOrders([1, 2], "staff-test");
    expect(result.group.shippingCountry).toBe("GB");
    expect(db.inserted).toEqual([expect.objectContaining({ table: combinedOrderGroups,
      value: expect.objectContaining({ shippingCountry: "GB" }) })]);
    expect(source.map(row => row.shippingCountry)).toEqual(["UK", "United Kingdom"]);
  });

  it.each(["stored group", "unselected member"])("rejects a contradictory %s before adding or dissolving groups", async conflict => {
    const db = new CombiningDb();
    db.reads.push([order(1, "US", 50), order(2, "US")], [{ enableOrderCombining: 1 }],
      [{ id: 50, shippingCountry: conflict === "stored group" ? "CA" : "US" }],
      [order(1, "US", 50), order(3, conflict === "unselected member" ? "CA" : "US", 50)]);
    await expect(createOrderCombiningService(db).combineOrders([1, 2], "staff-test"))
      .rejects.toThrow("different destination countries");
    expect(db.locks).toEqual(["update", "update", "update"]);
    expectNoWrites(db);
  });

  it("auto-combines only same-country candidates and persists canonical country inside a locked transaction", async () => {
    const db = new CombiningDb();
    db.rawOrders = [rawOrder(1, "Canada"), rawOrder(2, "ca"), rawOrder(3, "US"), rawOrder(4, "XX")];
    db.reads.push([{ enableOrderCombining: 1 }], []);
    expect(await createOrderCombiningService(db).combineAll("staff-test"))
      .toEqual({ groupsCreated: 1, totalOrdersCombined: 2 });
    expect(db.transactions).toBe(1);
    expect(db.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql))
      .toEqual([expect.stringContaining("pg_advisory_xact_lock"), expect.stringContaining("FOR UPDATE OF o")]);
    expect(db.inserted[0].value.shippingCountry).toBe("CA");
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it.each(["CA", "XX", null])("refuses shipping a historical group containing country %s", async country => {
    const db = new CombiningDb();
    db.reads.push([{ id: 50, shippingCountry: "US" }], [order(1, "US", 50), order(2, country, 50)]);
    await expect(createOrderCombiningService(db).getGroupForShipping(50))
      .rejects.toMatchObject({ name: "CombineError", statusCode: 400 });
    expectNoWrites(db);
  });
});
