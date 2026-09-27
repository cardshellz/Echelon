import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../inventory/cost-resolver", () => ({ resolveReturnCost: vi.fn(async () => ({ costCents: 25 })) }));
import { createReturnsService, type ProcessReturnParams } from "../../../orders/returns.service";

const dialect = new PgDialect();
const input = (): ProcessReturnParams => ({ orderId: 201, warehouseLocationId: 1, userId: "admin:test", items: [{ orderItemId: 301, productVariantId: 501, qty: 1, condition: "sellable" }] });
function fixture(root = false) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const execute = vi.fn(async query => {
    const rendered = dialect.sqlToQuery(query); const statement = rendered.sql; statements.push(statement); parameters.push(rendered.params);
    if (statement.includes("FROM wms.orders")) return { rows: [{ id: 201, oms_fulfillment_order_id: "100" }] };
    if (statement.includes("FROM returns.customer_return_authorizations")) return { rows: root ? [{ present: 1 }] : [] };
    if (statement.includes("FROM wms.order_items")) return { rows: [{ id: 301, oms_order_line_id: 101, product_variant_id: 501 }] };
    return { rows: [{ id: 100 }] };
  });
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ unitsPerVariant: 1 }] }) }) }));
  const tx = { execute, select };
  const transaction = vi.fn(async work => { try { const value = await work(tx); statements.push("COMMIT"); return value; } catch (error) { statements.push("ROLLBACK"); throw error; } });
  const core = { withTx: vi.fn(), receiveInventory: vi.fn(async () => undefined), adjustInventory: vi.fn(async () => undefined), logTransaction: vi.fn(async () => undefined) };
  core.withTx.mockReturnValue(core);
  return { statements, parameters, core, execute, tx, transaction, service: createReturnsService({ transaction }, core) };
}
describe("legacy inventory receiving portal fence", () => {
  it("blocks a portal source under the shared OMS/WMS locks without inventory effects", async () => {
    const h = fixture(true);
    await expect(h.service.processReturn(input())).rejects.toThrow("RETURN_CANONICAL_RECEIVING_REQUIRED");
    expect(h.statements.findIndex(statement => statement.includes("pg_advisory_xact_lock")))
      .toBeLessThan(h.statements.findIndex(statement => statement.includes("FROM returns.customer_return_authorizations")));
    expect(h.statements).toContain("ROLLBACK"); expect(h.core.receiveInventory).not.toHaveBeenCalled();
    const fence = h.statements.findIndex(statement => statement.includes("FROM returns.customer_return_authorizations"));
    expect(h.statements[fence]).toContain("requested.oms_order_line_id=al.oms_order_line_id");
    expect(h.statements[fence]).toContain("requested.id IN");
    expect(h.parameters[fence]).toEqual([201, 301]);
  });
  it("retains normal nonportal receipt and binds inventory writes to the fenced transaction", async () => {
    const h = fixture(); const result = await h.service.processReturn(input());
    expect(result.processed).toBe(1); expect(h.core.withTx).toHaveBeenCalledWith(h.tx);
    expect(h.core.receiveInventory).toHaveBeenCalledTimes(1); expect(h.core.logTransaction).toHaveBeenCalledTimes(1);
    expect(h.statements).toContain("COMMIT");
  });
  it("rolls back all effects if receipt audit persistence fails", async () => {
    const h = fixture(); h.core.logTransaction.mockRejectedValue(new Error("audit failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try { await expect(h.service.processReturn(input())).rejects.toThrow("audit failure"); }
    finally { log.mockRestore(); }
    expect(h.statements).toContain("ROLLBACK"); expect(h.statements).not.toContain("COMMIT");
  });
  it("rejects an order-item/variant mismatch before stock changes", async () => {
    const h = fixture(); const request = input(); request.items[0].productVariantId = 999;
    await expect(h.service.processReturn(request)).rejects.toThrow("RETURN_LEGACY_ITEM_MISMATCH");
    expect(h.core.receiveInventory).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid location %s before opening a transaction", async warehouseLocationId => {
    const h = fixture(); await expect(h.service.processReturn({ ...input(), warehouseLocationId })).rejects.toThrow("RETURN_LEGACY_INPUT_INVALID");
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it.each(["unknown", "", null])("rejects forged condition %s before opening a transaction", async condition => {
    const h = fixture(); const request = input(); request.items[0].condition = condition as "sellable";
    await expect(h.service.processReturn(request)).rejects.toThrow("RETURN_LEGACY_INPUT_INVALID");
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
