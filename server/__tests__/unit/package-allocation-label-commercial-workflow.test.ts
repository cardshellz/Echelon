import { DatabaseError, type Pool, type PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPackageAllocationLabelCommercialWorkflow } from "../../services/package-allocation-label-commercial-workflow";

const database = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => database }));

function fixture() {
  const release = vi.fn();
  const client = { release, query: vi.fn() } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const waitForRetry = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
  const workflow = createPackageAllocationLabelCommercialWorkflow({
    pool: { connect } as Pick<Pool, "connect">,
    clock: { now: () => new Date("2026-09-14T12:00:00Z") },
    logger,
    waitForRetry,
  });
  return { workflow, connect, release, logger, waitForRetry };
}

describe("atomic label commercial workflow transaction ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.execute.mockResolvedValue({ rows: [] });
    database.transaction.mockImplementation(async (work) => work(database));
  });

  it("keeps the connection until the SERIALIZABLE work completes", async () => {
    const f = fixture();
    const result = await f.workflow.run(async (context) => {
      expect(f.release).not.toHaveBeenCalled();
      expect(context.bootstrap.persistDiscovered).toBeTypeOf("function");
      expect(context.fulfillmentAuthority.materializeAndActivatePackageAllocationCommercialFulfillment)
        .toBeTypeOf("function");
      return "committed";
    });
    expect(result).toBe("committed");
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each(["40001", "40P01"])("retries the whole transaction after wrapped PostgreSQL %s", async (code) => {
    const f = fixture();
    const failure = new Error("Drizzle query failed", { cause: Object.assign(new Error("retryable database conflict"), { code }) });
    database.transaction.mockRejectedValueOnce(failure);
    const work = vi.fn().mockResolvedValue("committed");

    await expect(f.workflow.run(work)).resolves.toBe("committed");
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.release.mock.calls).toEqual([[failure], [undefined]]);
    expect(f.logger.warn).toHaveBeenCalledWith({ code: "LABEL_COMMERCIAL_TRANSACTION_FAILED", attempt: 1, retry: true });
  });

  it("stops after three serialization failures and releases every connection", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("serialization failed"), { code: "40001" });
    database.transaction.mockRejectedValue(failure);
    await expect(f.workflow.run(async () => undefined)).rejects.toBe(failure);
    expect(f.connect).toHaveBeenCalledTimes(3);
    expect(f.release.mock.calls).toEqual([[failure], [failure], [failure]]);
    expect(f.logger.warn).toHaveBeenLastCalledWith({ code: "LABEL_COMMERCIAL_TRANSACTION_FAILED", attempt: 3, retry: false });
    expect(f.waitForRetry.mock.calls).toEqual([[50], [100]]);
  });

  it("releases the failed connection before waiting for a conflicting writer to settle", async () => {
    const f = fixture();
    const failure = new DatabaseError("conflicting writer still active", 0, "error");
    failure.code = "40001";
    let competingWriterFinished = false;
    database.transaction.mockImplementation(async work => {
      if (!competingWriterFinished) throw failure;
      return work(database);
    });
    f.waitForRetry.mockImplementation(async () => {
      expect(f.release).toHaveBeenCalledTimes(1);
      // Waiting must not retain an aborted client or acquire the next one early.
      expect(f.connect).toHaveBeenCalledTimes(1);
      competingWriterFinished = true;
    });

    await expect(f.workflow.run(async () => "committed")).resolves.toBe("committed");
    expect(f.waitForRetry).toHaveBeenCalledExactlyOnceWith(50);
    expect(f.release.mock.calls).toEqual([[failure], [undefined]]);
  });

  it.each(["40001", "40P01"])("retries the actual PostgreSQL driver error %s", async (code) => {
    const f = fixture();
    const failure = new DatabaseError("database transaction conflict", 0, "error");
    failure.code = code;
    database.transaction.mockRejectedValueOnce(failure);

    await expect(f.workflow.run(async () => "committed")).resolves.toBe("committed");
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.release.mock.calls).toEqual([[failure], [undefined]]);
    expect(f.logger.warn).toHaveBeenCalledWith({ code: "LABEL_COMMERCIAL_TRANSACTION_FAILED", attempt: 1, retry: true });
  });

  it("preserves permanent failures without retrying a failed statement", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("invalid SQL parameter"), { code: "42P18" });
    database.transaction.mockRejectedValue(failure);
    await expect(f.workflow.run(async () => undefined)).rejects.toBe(failure);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.waitForRetry).not.toHaveBeenCalled();
  });

  it("propagates connection failure without releasing a connection it never acquired", async () => {
    const f = fixture();
    const failure = new Error("database unavailable");
    f.connect.mockRejectedValue(failure);
    await expect(f.workflow.run(async () => undefined)).rejects.toBe(failure);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.waitForRetry).not.toHaveBeenCalled();
  });
});
