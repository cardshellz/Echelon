import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function makeService(options?: {
  executeResults?: Array<{ rows?: any[] }>;
  status?: string;
  exists?: boolean;
}) {
  const executeResults = options?.executeResults ?? [{ rows: [] }, { rows: [] }];
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    transaction: vi.fn(),
  };
  const replenishment = {
    checkAndTriggerAfterPick: vi.fn(),
    checkReplenForLocation: vi.fn(async () => undefined),
  };
  const cc = options?.exists === false ? undefined : { id: 333, status: options?.status ?? "in_progress" };
  const storage = {
    getCycleCountById: vi.fn(async () => cc),
    getCycleCountItems: vi.fn(async () => []),
    updateCycleCount: vi.fn(async () => ({ id: 333, status: "cancelled" })),
    deleteCycleCount: vi.fn(async () => true),
  };

  const service = new CycleCountUseCases(db as any, {} as any, {} as any, replenishment as any, storage as any);
  return { db, replenishment, service, storage };
}

describe("CycleCountUseCases.cancel", () => {
  it("cancels an in_progress count, keeps inventory untouched, and closes linked replen blockers", async () => {
    const { service, storage, db, replenishment } = makeService({
      executeResults: [
        { rows: [] }, // unfreezeLocations
        { rows: [{ id: 121, to_location_id: 7, exception_reason: "source_empty" }] }, // closeLinkedReplenExceptionTasks
      ],
    });

    await expect(service.cancel(333)).resolves.toEqual({ success: true, linkedReplenBlockersClosed: 1 });

    expect(storage.updateCycleCount).toHaveBeenCalledWith(333, { status: "cancelled" });
    // No adjustment/ledger writes — only the freeze-release + replen-close UPDATEs.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(replenishment.checkReplenForLocation).toHaveBeenCalledWith(7);
  });

  it("refuses to cancel a completed count and writes nothing", async () => {
    const { service, storage, db } = makeService({ status: "completed" });
    await expect(service.cancel(333)).rejects.toThrow("Cannot cancel a completed cycle count");
    expect(storage.updateCycleCount).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("refuses to cancel an already-cancelled count", async () => {
    const { service, storage } = makeService({ status: "cancelled" });
    await expect(service.cancel(333)).rejects.toThrow("Cannot cancel a cancelled cycle count");
    expect(storage.updateCycleCount).not.toHaveBeenCalled();
  });

  it("404s when the count does not exist", async () => {
    const { service, storage } = makeService({ exists: false });
    await expect(service.cancel(333)).rejects.toThrow("Cycle count not found");
    expect(storage.updateCycleCount).not.toHaveBeenCalled();
  });
});

describe("CycleCountUseCases.delete", () => {
  it("deletes a count with no blocking references", async () => {
    const { service } = makeService();
    await expect(service.delete(333)).resolves.toEqual({ success: true });
  });

  it("surfaces a clear 409 (not a generic 500) when an FK violation blocks the delete", async () => {
    const { service, storage } = makeService();
    storage.deleteCycleCount = vi.fn(async () => {
      const err: any = new Error('update or delete on "cycle_counts" violates foreign key constraint');
      err.code = "23503";
      throw err;
    });
    await expect(service.delete(333)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Cancel it instead"),
    });
  });

  it("404s when nothing was deleted", async () => {
    const { service, storage } = makeService();
    storage.deleteCycleCount = vi.fn(async () => false);
    await expect(service.delete(333)).rejects.toThrow("Cycle count not found");
  });
});
