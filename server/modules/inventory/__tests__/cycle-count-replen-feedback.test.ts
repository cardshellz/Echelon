import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../application/cycle-count.use-cases";

function makeService(options?: {
  executeResults?: Array<{ rows?: any[] }>;
  items?: any[];
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
  const storage = {
    getCycleCountById: vi.fn(async () => ({ id: 333, status: "in_progress" })),
    getCycleCountItems: vi.fn(async () => options?.items ?? [
      {
        id: 444,
        cycleCountId: 333,
        status: "approved",
        varianceType: "quantity_under",
      },
    ]),
    updateCycleCount: vi.fn(async () => ({ id: 333, status: "completed" })),
  };

  const service = new CycleCountUseCases(
    db as any,
    {} as any,
    {} as any,
    replenishment as any,
    storage as any,
  );

  return { db, replenishment, service, storage };
}

describe("CycleCountUseCases replenishment feedback", () => {
  it("closes linked source-empty replen blockers when the linked count is completed", async () => {
    const { db, replenishment, service, storage } = makeService({
      executeResults: [
        { rows: [] },
        {
          rows: [
            { id: 121, to_location_id: 1 },
            { id: 122, to_location_id: 1 },
          ],
        },
      ],
    });

    await expect(service.complete(333)).resolves.toEqual({
      success: true,
      linkedReplenBlockersClosed: 2,
    });

    expect(storage.updateCycleCount).toHaveBeenCalledWith(333, expect.objectContaining({
      status: "completed",
      completedAt: expect.any(Date),
    }));
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(replenishment.checkReplenForLocation).toHaveBeenCalledTimes(1);
    expect(replenishment.checkReplenForLocation).toHaveBeenCalledWith(1);
  });

  it("does not close replen blockers if the count still has unresolved items", async () => {
    const { db, service } = makeService({
      items: [
        {
          id: 444,
          cycleCountId: 333,
          status: "pending",
          varianceType: null,
        },
      ],
    });

    await expect(service.complete(333)).rejects.toThrow("1 items still pending");
    expect(db.execute).not.toHaveBeenCalled();
  });
});
