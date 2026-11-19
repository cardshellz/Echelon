import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readShipmentPhysicalLines } from "../../shipment-physical-read.repository";

function reader(rows: unknown[] = []) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn((_condition: SQL) => ({ orderBy }));
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
  return { database: { select }, select, where };
}
describe("shipment physical source read", () => {
  it("reads only requested shipment lines in one parameterized batch without changing the evidence", async () => {
    const rows = [{ id: 11, inboundShipmentId: 1, qtyShipped: 500, cartonCount: 2, weightKg: "3.000", totalWeightKg: "999.000" }];
    const before = structuredClone(rows), db = reader(rows);
    const result = await readShipmentPhysicalLines(db.database as never, [1, 2, 1]);
    expect(result.get(1)).toEqual(rows); expect(result.get(2)).toEqual([]); expect(rows).toEqual(before);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(db.where.mock.calls[0][0]).params).toEqual([[1, 2]]);
  });
  it("does not query empty pages or invalid identifiers", async () => {
    const db = reader();
    expect(await readShipmentPhysicalLines(db.database as never, [])).toEqual(new Map());
    for (const id of [0, -1, 1.5, 2147483648]) await expect(readShipmentPhysicalLines(db.database as never, [id])).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
  it("rejects unexpected shipment identities instead of cross-linking their measurements", async () => {
    const db = reader([{ id: 11, inboundShipmentId: 3 }]);
    await expect(readShipmentPhysicalLines(db.database as never, [1])).rejects.toThrow("escaped its requested scope");
  });
});
