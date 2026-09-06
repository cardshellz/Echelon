import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { recordAssemblyOutputPickLocation } from "../../assembly-output-pick-command";

describe("assembly output WMS evidence", () => {
  const evidence = { orderId: 70, orderItemId: 71, locationCode: "FINISHED", zone: "PACK" };
  it("updates only the completed matching order line on the caller's transaction", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 71 }], rowCount: 1 }));
    await recordAssemblyOutputPickLocation({ query } as unknown as PoolClient, evidence);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("AND order_id=$4 AND status='completed'"), ["FINISHED", "PACK", 71, 70]);
  });
  it("rejects a changed/missing line instead of reporting success", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(recordAssemblyOutputPickLocation({ query } as unknown as PoolClient, evidence)).rejects.toMatchObject({ code: "WMS_PICK_PROGRESS_CHANGED" });
  });
  it.each([{ ...evidence, orderId: 0 }, { ...evidence, locationCode: "" }, { ...evidence, zone: "12345678901" }])("validates evidence before writing: %j", async (invalid) => {
    const query = vi.fn();
    await expect(recordAssemblyOutputPickLocation({ query } as unknown as PoolClient, invalid)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
