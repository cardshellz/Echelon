import { describe, expect, it, vi } from "vitest";
import { executeInventoryPublicationCommand } from "../../infrastructure/inventory-publication-command-transaction";

function fixture() {
  const clients = Array.from({ length: 3 }, () => ({ query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn() }));
  const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
  return { clients, pool: { connect } };
}

describe("inventory publication local command transaction", () => {
  it("rolls back and retries the entire command on a serialization conflict", async () => {
    const { clients, pool } = fixture();
    const work = vi.fn().mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "40001" })).mockResolvedValue("done");
    await expect(executeInventoryPublicationCommand(pool as never, work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(2);
    expect(clients[0].query).toHaveBeenCalledWith("ROLLBACK");
    expect(clients[1].query).toHaveBeenCalledWith("COMMIT");
    expect(clients[0].release).toHaveBeenCalledOnce(); expect(clients[1].release).toHaveBeenCalledOnce();
  });
  it("does not automatically replay an uncertain commit and discards that connection", async () => {
    const { clients, pool } = fixture();
    const uncertain = new Error("connection ended during commit");
    clients[0].query.mockImplementation(async sql => { if (sql === "COMMIT") throw uncertain; return { rows: [] }; });
    const work = vi.fn(async () => "done");
    await expect(executeInventoryPublicationCommand(pool as never, work)).rejects.toBe(uncertain);
    expect(work).toHaveBeenCalledOnce(); expect(clients[0].release).toHaveBeenCalledWith(uncertain);
  });
  it("bounds retries and exposes both command and rollback failure without reusing its connection", async () => {
    const { clients, pool } = fixture();
    const serialization = Object.assign(new Error("conflict"), { code: "40001" });
    await expect(executeInventoryPublicationCommand(pool as never, vi.fn().mockRejectedValue(serialization))).rejects.toBe(serialization);
    expect(pool.connect).toHaveBeenCalledTimes(3);
    const failed = fixture();
    const rollback = new Error("rollback failed");
    failed.clients[0].query.mockImplementation(async sql => { if (sql === "ROLLBACK") throw rollback; return { rows: [] }; });
    await expect(executeInventoryPublicationCommand(failed.pool as never, vi.fn().mockRejectedValue(serialization))).rejects.toMatchObject({ errors: [serialization, rollback] });
    expect(failed.pool.connect).toHaveBeenCalledOnce(); expect(failed.clients[0].release).toHaveBeenCalledWith(rollback);
  });
});
