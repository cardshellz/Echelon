import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { releaseLineItemFromHold } from "../../line-item-hold";

const dialect = new PgDialect();
const NOW = new Date("2026-10-01T12:00:00Z");

interface Script {
  order?: Record<string, unknown> | null;
  line?: Record<string, unknown> | null;
  heldShipmentId?: number | null;
}

// Scripted transaction: answers the two locking reads and the held-shipment
// lookup, and records every statement so tests can prove what was written.
function scriptedDb(script: Script) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const execute = vi.fn(async (query: any) => {
    const rendered = dialect.sqlToQuery(query);
    const text = rendered.sql.replace(/\s+/g, " ").trim();
    statements.push({ text, params: rendered.params });
    if (/FROM wms\.orders WHERE .* FOR UPDATE/.test(text)) return { rows: script.order ? [script.order] : [] };
    if (/FROM wms\.order_items WHERE .* FOR UPDATE/.test(text)) return { rows: script.line ? [script.line] : [] };
    if (/JOIN wms\.outbound_shipments os/.test(text)) {
      return { rows: script.heldShipmentId ? [{ id: script.heldShipmentId }] : [] };
    }
    return { rows: [] };
  });
  const db = { transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ execute })) };
  const writes = () => statements.filter((statement) => /^(UPDATE|INSERT|DELETE)\b/.test(statement.text));
  return { db, statements, writes };
}

const openOrder = { id: 7, on_hold: 0, warehouse_status: "ready" };
const heldLine = { id: 55, order_id: 7, on_hold: true, status: "pending", quantity: 2 };
const args = { wmsOrderId: 7, orderItemId: 55, now: NOW };

describe("releaseLineItemFromHold", () => {
  it("locks the order row, then the line row, before deciding (the pick path's lock order)", async () => {
    const { db, statements } = scriptedDb({ order: openOrder, line: heldLine, heldShipmentId: 900 });
    await releaseLineItemFromHold(db, args);
    expect(statements[0].text).toMatch(/^SELECT id, on_hold, warehouse_status FROM wms\.orders WHERE id = \$1 FOR UPDATE$/);
    expect(statements[0].params).toEqual([7]);
    expect(statements[1].text).toMatch(/FROM wms\.order_items WHERE id = \$1 FOR UPDATE$/);
    expect(statements[1].params).toEqual([55]);
  });

  it("clears the line hold and un-holds its shipment in the same transaction", async () => {
    const { db, writes } = scriptedDb({ order: openOrder, line: heldLine, heldShipmentId: 900 });

    const result = await releaseLineItemFromHold(db, args);

    expect(result).toEqual({ outcome: "released", heldShipmentId: 900, orderStatus: "ready", lineWasHeld: true });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [lineUpdate, shipmentUpdate] = writes();
    expect(lineUpdate.text).toMatch(/^UPDATE wms\.order_items SET on_hold = false, hold_reason = NULL WHERE id = \$1$/);
    expect(lineUpdate.params).toEqual([55]);
    expect(shipmentUpdate.text).toMatch(/^UPDATE wms\.outbound_shipments SET held = false, held_at = NULL, on_hold_reason = NULL/);
    expect(shipmentUpdate.params).toEqual([NOW, 900]);
  });

  it("clears only the flag when the line never got its own held shipment", async () => {
    const { db, writes } = scriptedDb({ order: openOrder, line: heldLine, heldShipmentId: null });
    const result = await releaseLineItemFromHold(db, args);
    expect(result.outcome).toBe("released");
    expect(result.heldShipmentId).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ["the order flag is set", { ...openOrder, on_hold: 1 }, "order_on_hold"],
    ["the order has the legacy on_hold status", { ...openOrder, warehouse_status: "on_hold" }, "order_on_hold"],
    ["the order shipped", { ...openOrder, warehouse_status: "shipped" }, "order_terminal"],
    ["the order was cancelled", { ...openOrder, warehouse_status: "cancelled" }, "order_terminal"],
  ])("refuses without writing anything when %s", async (_case, order, outcome) => {
    const { db, writes } = scriptedDb({ order, line: heldLine, heldShipmentId: 900 });
    const result = await releaseLineItemFromHold(db, args);
    expect(result.outcome).toBe(outcome);
    expect(result.heldShipmentId).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("is a no-op for a line that is no longer held (a replay or a second operator)", async () => {
    const { db, writes } = scriptedDb({ order: openOrder, line: { ...heldLine, on_hold: false }, heldShipmentId: 900 });
    const result = await releaseLineItemFromHold(db, args);
    expect(result).toEqual({ outcome: "not_held", heldShipmentId: null, orderStatus: "ready", lineWasHeld: false });
    expect(writes()).toEqual([]);
  });

  it("reports not_found for a missing row or a line on another order, without writing", async () => {
    for (const script of [
      { order: null, line: heldLine },
      { order: openOrder, line: null },
      { order: openOrder, line: { ...heldLine, order_id: 8 } },
    ]) {
      const { db, writes } = scriptedDb(script);
      expect((await releaseLineItemFromHold(db, args)).outcome).toBe("not_found");
      expect(writes()).toEqual([]);
    }
  });
});
