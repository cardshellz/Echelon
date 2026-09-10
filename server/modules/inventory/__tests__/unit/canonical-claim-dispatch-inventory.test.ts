import { describe, expect, it, vi } from "vitest";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { DISPATCH_TIME, dispatchCosts, dispatchPlan } from "../fixtures/canonical-claim-dispatch";

function fixture() {
  const level = { id: 60, warehouse_id: 1, warehouse_location_id: 50, product_variant_id: 105, variant_qty: 10, reserved_qty: 4, picked_qty: 8 };
  const lots = [
    { id: 401, warehouse_location_id: 50, product_variant_id: 105, qty_on_hand: 4, qty_reserved: 1, qty_picked: 4, status: "active" },
    { id: 402, warehouse_location_id: 50, product_variant_id: 105, qty_on_hand: 6, qty_reserved: 3, qty_picked: 2, status: "active" },
  ];
  const state = { level, lots, costs: dispatchCosts(), existing: [] as { id: number }[], updateCount: 1, journalId: 801 };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM inventory.quantity_ledger_opening")) return { rows: [] };
    if (sql.startsWith("SELECT pg_advisory")) return { rows: [] };
    if (sql.includes("SELECT id FROM inventory.inventory_transactions")) return { rows: state.existing };
    if (sql.includes("FROM inventory.inventory_levels")) return { rows: [state.level] };
    if (sql.includes("FROM inventory.inventory_lots")) return { rows: state.lots };
    if (sql.includes("FROM oms.order_item_costs")) return { rows: state.costs };
    if (sql.startsWith("UPDATE inventory.")) return { rows: [], rowCount: state.updateCount };
    if (sql.startsWith("INSERT INTO inventory.inventory_transactions")) return { rows: [{ id: state.journalId }], rowCount: 1 };
    throw new Error(`Unexpected owner query: ${sql} (${JSON.stringify(values)})`);
  });
  const repository = new PostgresCanonicalClaimInventoryRepository();
  const plan = dispatchPlan();
  return { state, query, repository, plan,
    run: () => repository.dispatchPickedResources({ client: { query }, plan, occurredAt: DISPATCH_TIME }) };
}

describe("canonical inventory owner dispatch", () => {
  it("clears exact two-lot picked custody, preserves other stock and records one zero-onhand ship row", async () => {
    const f = fixture(); const original = structuredClone(f.plan);
    await expect(f.run()).resolves.toEqual({ inventoryTransactionId: 801, quantity: "5", physicalOnHandDelta: "0",
      reservedQuantityDelta: "0", pickedQuantityDelta: "-5" });
    const writes = f.query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT)/.test(sql));
    expect(writes).toHaveLength(4);
    expect(writes.slice(0, 2).map(([, values]) => values)).toEqual([[3, 401], [2, 402]]);
    expect(writes[2][1]).toEqual([5, 60, DISPATCH_TIME]);
    expect(writes[3][0]).toContain("'ship', 0, $3, $3, 0, 'picked', 'shipped'");
    expect(writes[3][1]).toEqual([105, 50, 10, 70, 71, 90, 101, f.plan.commandHash, "Confirmed source dispatch", "shipping-worker", DISPATCH_TIME]);
    const sql = writes.map(([value]) => value).join("\n");
    expect(sql).not.toMatch(/SET\s+(variant_qty|reserved_qty|qty_on_hand|qty_reserved|qty_consumed)/);
    expect(sql).not.toContain("oms.order_item_costs");
    expect(f.query.mock.calls.some(([value]) => /^(BEGIN|COMMIT|ROLLBACK)/.test(value))).toBe(false);
    expect(f.plan).toEqual(original);
  });
  it("locks legacy source keys, then exact level, lots and immutable original costs before writing", async () => {
    const f = fixture(); await f.run();
    const sql = f.query.mock.calls.map(([value]) => value);
    expect(f.query.mock.calls.slice(0, 2).map(([, values]) => values)).toEqual([[918407, 71], [918407, 101]]);
    const level = sql.findIndex((value) => value.includes("FROM inventory.inventory_levels"));
    const lots = sql.findIndex((value) => value.includes("FROM inventory.inventory_lots"));
    const costs = sql.findIndex((value) => value.includes("FROM oms.order_item_costs"));
    expect(level).toBeLessThan(lots); expect(lots).toBeLessThan(costs);
    expect(sql[level]).toContain("FOR UPDATE"); expect(sql[lots]).toContain("FOR UPDATE");
    expect(sql[costs]).toContain("FOR SHARE");
    expect(costs).toBeLessThan(sql.findIndex((value) => value.startsWith("UPDATE")));
  });
  it("rejects any previous ship source or old shipment/order-item row before mutation", async () => {
    const f = fixture(); f.state.existing.push({ id: 2 });
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_ALREADY_POSTED" });
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("shipment_item_id = $1 OR (shipment_id = $2 AND order_item_id = $3)");
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it.each([
    ["level shortage", (f: ReturnType<typeof fixture>) => { f.state.level.picked_qty = 4; }, "CLAIM_DISPATCH_PICKED_SHORTFALL"],
    ["lot shortage without FIFO fallback", (f: ReturnType<typeof fixture>) => { f.state.lots[1].qty_picked = 1; }, "CLAIM_DISPATCH_PICKED_SHORTFALL"],
    ["foreign level", (f: ReturnType<typeof fixture>) => { f.state.level.product_variant_id = 999; }, "CLAIM_DISPATCH_LEVEL_IDENTITY_MISMATCH"],
    ["foreign physical warehouse", (f: ReturnType<typeof fixture>) => { f.state.level.warehouse_id = 2; }, "CLAIM_DISPATCH_LEVEL_IDENTITY_MISMATCH"],
    ["foreign lot", (f: ReturnType<typeof fixture>) => { f.state.lots[0].warehouse_location_id = 999; }, "CLAIM_DISPATCH_LOT_IDENTITY_MISMATCH"],
    ["missing lot", (f: ReturnType<typeof fixture>) => { f.state.lots.pop(); }, "CLAIM_DISPATCH_LOT_IDENTITY_MISMATCH"],
    ["negative custody", (f: ReturnType<typeof fixture>) => { f.state.lots[0].qty_picked = -1; }, "CLAIM_DISPATCH_INVALID_INVENTORY"],
    ["foreign order cost", (f: ReturnType<typeof fixture>) => { f.state.costs[0].orderId = 999; }, "CLAIM_DISPATCH_COST_IDENTITY_MISMATCH"],
    ["changed original cost", (f: ReturnType<typeof fixture>) => { f.state.costs[0].unitCostMills = "200"; f.state.costs[0].totalCostMills = "600"; }, "CLAIM_DISPATCH_COST_IDENTITY_MISMATCH"],
    ["missing original cost", (f: ReturnType<typeof fixture>) => { f.state.costs.pop(); }, "CLAIM_DISPATCH_COST_EVIDENCE_MISSING"],
    ["broken original cost total", (f: ReturnType<typeof fixture>) => { f.state.costs[0].totalCostMills = "301"; }, "CLAIM_DISPATCH_COST_EVIDENCE_MISSING"],
  ] as const)("rejects %s before any write", async (_name, change, code) => {
    const f = fixture(); change(f);
    await expect(f.run()).rejects.toMatchObject({ code });
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("rejects malformed plan before querying", async () => {
    const f = fixture(); f.plan.resources[0].lots[0].quantity = "4";
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_INVALID_PLAN" }); expect(f.query).not.toHaveBeenCalled();
  });
  it("requires a valid injected timestamp before querying", async () => {
    const f = fixture();
    await expect(f.repository.dispatchPickedResources({ client: { query: f.query }, plan: f.plan, occurredAt: new Date("invalid") }))
      .rejects.toMatchObject({ code: "CLAIM_DISPATCH_INVALID_TIMESTAMP" }); expect(f.query).not.toHaveBeenCalled();
  });
  it("propagates a guarded update failure for caller rollback without journal insertion", async () => {
    const f = fixture(); f.state.updateCount = 0;
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_PICKED_CONFLICT" });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("loads original costs as exact decimal strings with bounded sorted IDs and no hidden locks", async () => {
    const f = fixture();
    await expect(f.repository.loadDispatchCosts({ client: { query: f.query }, costIds: [302, 301, 302] })).resolves.toEqual(dispatchCosts());
    expect(f.query.mock.calls[0][1]).toEqual([[301, 302]]); expect(f.query.mock.calls[0][0]).not.toContain("FOR SHARE");
  });
  it("returns no rows without a database query for an empty cost set", async () => {
    const f = fixture(); await expect(f.repository.loadDispatchCosts({ client: { query: f.query }, costIds: [] })).resolves.toEqual([]);
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([[-1], [0], [1.2], [2_147_483_648], Array.from({ length: 10_001 }, () => 1)].map((ids) => ({ ids })))("rejects invalid or unbounded cost IDs", async ({ ids }) => {
    const f = fixture(); await expect(f.repository.loadDispatchCosts({ client: { query: f.query }, costIds: ids }))
      .rejects.toMatchObject({ code: "CLAIM_DISPATCH_INVALID_COST_IDS" }); expect(f.query).not.toHaveBeenCalled();
  });
});
