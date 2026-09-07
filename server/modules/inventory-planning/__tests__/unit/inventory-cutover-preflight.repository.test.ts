import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresInventoryCutoverPreflightRepository } from "../../infrastructure/inventory-cutover-preflight.repository";
import { readWmsCutoverDemand } from "../../../wms/inventory-cutover-demand-reader";
import { captureInventoryCutoverEncumbranceInsideTransaction } from "../../../inventory/infrastructure/inventory-cutover-encumbrance.repository";
import { cutoverPreflightFacts } from "../fixtures/inventory-cutover-preflight.fixture";

vi.mock("../../../../db", () => ({ pool: { connect: vi.fn() } }));
vi.mock("../../../wms/inventory-cutover-demand-reader", () => ({ readWmsCutoverDemand: vi.fn() }));
vi.mock("../../../inventory/infrastructure/inventory-cutover-encumbrance.repository", () => ({
  captureInventoryCutoverEncumbranceInsideTransaction: vi.fn(),
}));

const BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";

beforeEach(() => {
  vi.resetAllMocks();
  const facts = cutoverPreflightFacts();
  vi.mocked(readWmsCutoverDemand).mockResolvedValue(facts.demand);
  vi.mocked(captureInventoryCutoverEncumbranceInsideTransaction).mockResolvedValue(facts.encumbrance);
});

describe("cutover preflight repository transaction ownership", () => {
  it("shares one read-only snapshot across owner readers and commits before releasing", async () => {
    const { repository, client, query, release, connect } = fixture();
    const result = await repository.capture();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(readWmsCutoverDemand).toHaveBeenCalledExactlyOnceWith(client);
    expect(captureInventoryCutoverEncumbranceInsideTransaction).toHaveBeenCalledExactlyOnceWith(client);
    expect(query.mock.calls[0]![0]).toBe(BEGIN);
    expect(query.mock.calls[1]![0]).toBe("SET LOCAL statement_timeout = '30s'");
    expect(query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(result).toMatchObject({ capturedAt: cutoverPreflightFacts().demand.capturedAt,
      runtimeAuthority: "legacy", authorityRevision: "1", variants: cutoverPreflightFacts().variants });
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|pg_advisory|FOR\s+SHARE)\b/i);
    }
    const catalogCall = query.mock.calls.find(([sql]) => sql.includes("FROM catalog.product_variants"));
    expect(catalogCall?.[1]).toEqual([["P5"], 50_001]);
    expect(query.mock.invocationCallOrder.at(-1)).toBeLessThan(release.mock.invocationCallOrder[0]!);
  });

  it("propagates client acquisition failure without attempting queries or owner reads", async () => {
    const failure = new Error("Pool acquisition failed");
    const connect = vi.fn().mockRejectedValue(failure);
    const repository = new PostgresInventoryCutoverPreflightRepository({ connect } as unknown as Pick<Pool, "connect">);
    await expect(repository.capture()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(readWmsCutoverDemand).not.toHaveBeenCalled();
    expect(captureInventoryCutoverEncumbranceInsideTransaction).not.toHaveBeenCalled();
  });

  it("discards an acquired connection when BEGIN completion is uncertain", async () => {
    const failure = new Error("Connection failed while starting snapshot");
    const { repository, query, release } = fixture({ fail: (sql) => sql === BEGIN ? failure : undefined });
    await expect(repository.capture()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledExactlyOnceWith(BEGIN);
    expect(release).toHaveBeenCalledExactlyOnceWith(failure);
    expect(readWmsCutoverDemand).not.toHaveBeenCalled();
  });

  it("discards a failed BEGIN session even when the rejection is not an Error", async () => {
    const { repository, release } = fixture({ fail: (sql) => sql === BEGIN ? "start transport failed" : undefined });
    await expect(repository.capture()).rejects.toBe("start transport failed");
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: "Cutover snapshot start failed.", cause: "start transport failed",
    }));
  });

  it.each(["SET LOCAL", "availability_runtime_authority", "catalog.product_variants", "COMMIT"])(
    "rolls back exactly once after %s fails and preserves the original error", async (marker) => {
      const failure = Object.assign(new Error("Snapshot query failed"), { code: "57014" });
      const { repository, query, release } = fixture({ fail: (sql) => sql.includes(marker) ? failure : undefined });
      await expect(repository.capture()).rejects.toBe(failure);
      expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
      expect(query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(1);
      expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
      if (marker !== "COMMIT") expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    },
  );

  it.each(["wms", "inventory"])("rolls back when the %s owner reader fails", async (owner) => {
    const failure = new Error("Owner reader failed");
    if (owner === "wms") vi.mocked(readWmsCutoverDemand).mockRejectedValue(failure);
    else vi.mocked(captureInventoryCutoverEncumbranceInsideTransaction).mockRejectedValue(failure);
    const { repository, query, release } = fixture();
    await expect(repository.capture()).rejects.toBe(failure);
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
    if (owner === "wms") expect(captureInventoryCutoverEncumbranceInsideTransaction).not.toHaveBeenCalled();
  });

  it("aggregates read and rollback failure and destroys the uncertain connection", async () => {
    const readError = new Error("Read failed");
    const rollbackError = new Error("Rollback failed");
    vi.mocked(readWmsCutoverDemand).mockRejectedValue(readError);
    const { repository, query, release } = fixture({ fail: (sql) => sql === "ROLLBACK" ? rollbackError : undefined });
    await expect(repository.capture()).rejects.toMatchObject({
      name: "AggregateError", errors: [readError, rollbackError],
    });
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledExactlyOnceWith(rollbackError);
  });

  it("normalizes a non-Error rollback rejection for pool destruction without losing either cause", async () => {
    const readError = new Error("Read failed");
    vi.mocked(readWmsCutoverDemand).mockRejectedValue(readError);
    const { repository, release } = fixture({ fail: (sql) => sql === "ROLLBACK" ? "transport unavailable" : undefined });
    await expect(repository.capture()).rejects.toMatchObject({ name: "AggregateError", errors: [readError, "transport unavailable"] });
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Cutover snapshot rollback failed." }));
  });

  it.each([
    [{ authority: "unknown", revision: "1" }],
    [{ authority: "legacy", revision: "0" }],
    [{ authority: "legacy", revision: "1" }, { authority: "canonical", revision: "2" }],
  ])("rejects invalid authority evidence before owner reads: %j", async (authorityRows) => {
    const { repository, query, release } = fixture({ authorityRows });
    await expect(repository.capture()).rejects.toHaveProperty("name", "ZodError");
    expect(readWmsCutoverDemand).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("represents missing runtime authority as unknown instead of inventing a default", async () => {
    const { repository } = fixture({ authorityRows: [] });
    expect(await repository.capture()).toMatchObject({ runtimeAuthority: null, authorityRevision: null });
  });

  it("skips catalog lookup for a digital-only WMS cohort", async () => {
    const facts = cutoverPreflightFacts(); facts.demand.items[0]!.requiresShipping = 0;
    vi.mocked(readWmsCutoverDemand).mockResolvedValue(facts.demand);
    const { repository, query } = fixture();
    expect((await repository.capture()).variants).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes("catalog.product_variants"))).toBe(false);
  });
});

function fixture(options: { fail?: (sql: string) => unknown; authorityRows?: unknown[] } = {}) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    const failure = options.fail?.(sql);
    if (failure !== undefined) throw failure;
    if (sql.includes("availability_runtime_authority")) return { rows: options.authorityRows ?? [{ authority: "legacy", revision: "1" }] };
    if (sql.includes("FROM catalog.product_variants")) return { rows: cutoverPreflightFacts().variants };
    if ([BEGIN, "SET LOCAL statement_timeout = '30s'", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL in preflight repository test: ${sql}`);
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  const repository = new PostgresInventoryCutoverPreflightRepository({ connect } as unknown as Pick<Pool, "connect">);
  return { repository, client, query, release, connect };
}
