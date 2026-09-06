import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { requireAssemblyOrderAuthority } from "../../assembly-handoff-authority";

const input = { orderId: 70, orderItemId: 71, actorId: "picker", action: "handoff" as const };
const row = { warehouse_status: "in_progress", on_hold: 0, assigned_picker_id: "picker", item_on_hold: 0, item_status: "pending", requires_shipping: 1 };
function client(record: unknown) { return { query: vi.fn(async () => ({ rows: record ? [record] : [] })) } as unknown as PoolClient; }
describe("WMS assembly handoff authority", () => {
  it("permits the owning picker and does not change the order or item", async () => {
    const db = client(row); await requireAssemblyOrderAuthority(db, input);
    expect(db.query).toHaveBeenCalledOnce();
    expect(vi.mocked(db.query).mock.calls[0][0]).toContain("SELECT orders.warehouse_status");
  });
  it.each([null, { ...row, warehouse_status: "shipped" }, { ...row, warehouse_status: "cancelled" },
    { ...row, on_hold: 1 }, { ...row, item_on_hold: 1 }, { ...row, requires_shipping: 0 }, { ...row, item_status: "cancelled" },
    { ...row, item_status: "completed" }, { ...row, item_status: "short" }])("rejects missing, held, terminal or nonphysical work", async (record) => {
    await expect(requireAssemblyOrderAuthority(client(record), input)).rejects.toMatchObject({ code: "WORK_ORDER_NOT_EXECUTABLE" });
  });
  it("rejects sending another picker's job", async () => {
    await expect(requireAssemblyOrderAuthority(client({ ...row, assigned_picker_id: "other" }), input)).rejects.toMatchObject({ code: "WORK_ORDER_PICKER_MISMATCH" });
  });
  it("does not require the assembler to pretend to be the picker", async () => {
    await expect(requireAssemblyOrderAuthority(client(row), { ...input, actorId: "assembler", action: "complete" })).resolves.toBeUndefined();
  });
});
