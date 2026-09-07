import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyPackageReviewService } from "../../work/application/assembly-package-review.service";
import { readOrderPackingSources } from "../../../wms/packing-source-reader";
import { readObservedPackagesForSources } from "../../../shipping/package-allocation-ledger.repository";
import { task } from "../assembly-work.fixture";
vi.mock("../../../wms/packing-source-reader", () => ({ readOrderPackingSources: vi.fn() }));
vi.mock("../../../shipping/package-allocation-ledger.repository", () => ({ readObservedPackagesForSources: vi.fn() }));
function harness() {
  const query = vi.fn(async (_sql: string) => ({ rows: [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) };
  const work = { get: vi.fn(async () => task({ assignedTo: "assembler" })) };
  return { query, release, client, pool, work, service: new AssemblyPackageReviewService(work, pool) };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readOrderPackingSources).mockResolvedValue([]); vi.mocked(readObservedPackagesForSources).mockResolvedValue([]); });
describe("scoped package review transaction", () => {
  it("authorizes first, then uses one read-only snapshot for source and package owners", async () => {
    const h = harness();
    expect(await h.service.review("assembler", "1")).toMatchObject({ readOnly: true, packages: [] });
    expect(h.work.get).toHaveBeenCalledWith("assembler", "1");
    expect(h.work.get.mock.invocationCallOrder[0]).toBeLessThan(h.pool.connect.mock.invocationCallOrder[0]);
    expect(h.query).toHaveBeenNthCalledWith(1, "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(readOrderPackingSources).toHaveBeenCalledWith(h.client, 70, 1);
    expect(readObservedPackagesForSources).toHaveBeenCalledWith(h.client, []);
    expect(h.query).toHaveBeenLastCalledWith("COMMIT"); expect(h.release).toHaveBeenCalledWith(undefined);
  });
  it("does not access evidence for unauthorized or unassigned workers", async () => {
    const h = harness(); h.work.get.mockRejectedValueOnce(new Error("Scope denied"));
    await expect(h.service.review("assembler", "1")).rejects.toThrow("Scope denied");
    await expect(h.service.review("other", "1")).rejects.toThrow("assigned assembler");
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
  it("rolls back failed owner reads and never returns stale partial evidence", async () => {
    const h = harness(); vi.mocked(readObservedPackagesForSources).mockRejectedValue(new Error("Evidence changed"));
    await expect(h.service.review("assembler", "1")).rejects.toThrow("Evidence changed");
    expect(h.query).toHaveBeenLastCalledWith("ROLLBACK"); expect(h.query).not.toHaveBeenCalledWith("COMMIT");
  });
  it("discards the client when rollback fails", async () => {
    const h = harness(); vi.mocked(readOrderPackingSources).mockRejectedValue(new Error("Reader failure"));
    h.query.mockImplementation(async (sql) => { if (sql === "ROLLBACK") throw new Error("Rollback failure"); return { rows: [] }; });
    await expect(h.service.review("assembler", "1")).rejects.toThrow("rollback failed");
    expect(h.release).toHaveBeenCalledWith(expect.any(AggregateError));
  });
});
