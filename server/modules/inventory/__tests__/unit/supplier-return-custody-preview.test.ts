import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { readLotCostQuantityState } from "../../infrastructure/cost-quantity.repository";

const lot = { id: 5, qty_received: 3, qty_on_hand: 3, qty_picked: 0, qty_packed: 0,
  cost_basis_qty: 3, product_total_cost_mills: 7, packaging_total_cost_mills: 0, landed_total_cost_mills: 0 };
function reader(history = { has_cogs: false, has_outflow: false, has_physical_outflow: false }) {
  const statements: string[] = [];
  const execute = vi.fn(async (value: unknown) => {
    const statement = new PgDialect().sqlToQuery(value as SQL).sql;
    statements.push(statement);
    if (/FROM inventory\.lot_cost_quantity_bases/.test(statement)) return { rows: [] };
    if (/FROM inventory\.lot_cost_quantity_allocations/.test(statement)) return { rows: [] };
    if (/AS has_cogs/.test(statement)) return { rows: [history] };
    throw new Error(`Unexpected preview statement ${statement}`);
  });
  return { tx: { execute }, statements };
}
describe("read-only first consumption preview", () => {
  it("can preview an untouched exact transfer lot without creating cost custody", async () => {
    const fixture = reader();
    expect(await readLotCostQuantityState(fixture.tx, lot)).toMatchObject({
      basisQuantity: 3, freshUnconsumed: true, freeIntervals: [{ start: 0, quantity: 3 }],
    });
    expect(fixture.statements.every(statement => statement.trim().startsWith("SELECT"))).toBe(true);
  });
  it.each(["has_cogs", "has_outflow", "has_physical_outflow"] as const)("does not adopt historical quantity when %s exists", async field => {
    const fixture = reader({ has_cogs: false, has_outflow: false, has_physical_outflow: false, [field]: true });
    expect(await readLotCostQuantityState(fixture.tx, lot)).toMatchObject({ basisQuantity: null, freshUnconsumed: false });
  });
  it.each([{ qty_on_hand: 2 }, { qty_picked: 1 }, { qty_packed: 1 }])("requires the complete original lot to remain unconsumed: %j", async changed => {
    expect(await readLotCostQuantityState(reader().tx, { ...lot, ...changed })).toMatchObject({ basisQuantity: null, freshUnconsumed: false });
  });
});
