import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { packingReadinessBlockers, recordAssemblyPackingReady, type PackingReadiness } from "../../assembly-packing-readiness";
const evidence = (): PackingReadiness => ({ order: { id: 70, warehouse_id: 1, warehouse_status: "in_progress", on_hold: 0 },
  items: [{ id: 71, sku: "P5", quantity: 2, picked_quantity: 2, status: "completed", on_hold: false, requires_shipping: 1, location: "FINISHED" }], exceptionIds: [] });
describe("packing readiness", () => {
  it("requires real complete picks, not a printed label or completed build alone", () => {
    const row = evidence(); expect(packingReadinessBlockers(row, 1, 71, [])).toEqual([]);
    row.items[0].picked_quantity = 0; expect(packingReadinessBlockers(row, 1, 71, [])).toContain("P5: pick incomplete");
  });
  it.each(["shipped", "cancelled", "partially_shipped", "exception"] as const)("never reopens %s", (status) => {
    const row = evidence(); row.order.warehouse_status = status;
    expect(packingReadinessBlockers(row, 1, 71, []).length).toBeGreaterThan(0);
  });
  it("excludes separately held, cancelled, and digital lines but not the selected assembly line", () => {
    const row = evidence(); row.items.push({ ...row.items[0], id: 72, status: "pending", picked_quantity: 0, on_hold: true });
    expect(packingReadinessBlockers(row, 1, 71, [])).toEqual([]);
    expect(packingReadinessBlockers(row, 1, 72, [])).toContain("Assembly line is not eligible physical work");
  });
  it("uses the existing status owner and exact transaction with deterministic time", async () => {
    const query = vi.fn(async () => ({ rows: [{ new_status: "ready_to_ship" }] }));
    const time = new Date("2026-09-06T12:00:00.000Z");
    await recordAssemblyPackingReady({ query } as unknown as PoolClient, evidence(), () => time);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE wms.orders"), expect.arrayContaining(["ready_to_ship", time, 70]));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
