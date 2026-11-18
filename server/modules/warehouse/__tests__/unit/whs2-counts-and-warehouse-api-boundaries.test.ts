import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CycleCountUseCases } from "../../../inventory/application/cycle-count.use-cases";
import { runCycleCountFreezeGuard } from "../../../inventory/cycle-count-freeze-guard.scheduler";
import * as binAssignmentApi from "../../bin-assignment.api";
import * as cutoverWorkApi from "../../cutover-work.api";
import * as warehouseIndex from "../../index";
import * as inventoryGovernanceApi from "../../inventory-governance.api";

function makeCycleCountService(overrides?: {
  cycleCount?: any;
  item?: any;
  items?: any[];
  executeImpl?: (q: any) => Promise<any>;
  deleteImpl?: (id: number) => Promise<boolean>;
  updateImpl?: (id: number, patch: any) => Promise<any>;
}) {
  const callOrder: string[] = [];
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(async (q: any) => {
      callOrder.push("db.execute");
      if (overrides?.executeImpl) {
        return overrides.executeImpl(q);
      }
      return { rows: [] };
    }),
    transaction: vi.fn(),
  };

  const replenishment = {
    checkAndTriggerAfterPick: vi.fn(),
    checkReplenForLocation: vi.fn(async () => undefined),
  };

  const storage = {
    getCycleCountById: vi.fn(async () =>
      overrides && "cycleCount" in overrides
        ? overrides.cycleCount
        : { id: 400, status: "in_progress", warehouseId: 1 },
    ),
    getCycleCountItems: vi.fn(async () => overrides?.items ?? []),
    getCycleCountItemById: vi.fn(async () =>
      overrides && "item" in overrides
        ? overrides.item
        : {
            id: 90,
            cycleCountId: 400,
            status: "pending",
            countedQty: 5,
            varianceQty: 1,
          },
    ),
    updateCycleCountItem: vi.fn(async (_itemId: number, patch: any) => ({
      id: 90,
      cycleCountId: 400,
      ...patch,
    })),
    updateCycleCount: vi.fn(async (id: number, patch: any) => {
      callOrder.push(`storage.updateCycleCount:${patch.status ?? "other"}`);
      if (overrides?.updateImpl) {
        return overrides.updateImpl(id, patch);
      }
      return { id, ...patch };
    }),
    deleteCycleCount: vi.fn(async (id: number) => {
      callOrder.push("storage.deleteCycleCount");
      if (overrides?.deleteImpl) {
        return overrides.deleteImpl(id);
      }
      return true;
    }),
  };

  const service = new CycleCountUseCases(
    db as any,
    {} as any,
    {} as any,
    replenishment as any,
    storage as any,
    {} as any,
  );

  return { service, db, storage, replenishment, callOrder };
}

describe("WHS-2 — Cycle Count Safeguards (COUNT-01..04) & Item Parent Guards", () => {
  describe("COUNT-01: delete(id) does not unfreeze bins when delete fails or 409s", () => {
    it("does not execute unfreezeLocations when deleteCycleCount throws 23503 FK violation", async () => {
      const { service, db, callOrder } = makeCycleCountService({
        deleteImpl: async () => {
          const err: any = new Error("violates foreign key constraint");
          err.code = "23503";
          throw err;
        },
      });

      await expect(service.delete(400)).rejects.toMatchObject({
        statusCode: 409,
      });

      expect(db.execute).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["storage.deleteCycleCount"]);
    });

    it("does not execute unfreezeLocations when deleteCycleCount returns false (404)", async () => {
      const { service, db, callOrder } = makeCycleCountService({
        deleteImpl: async () => false,
      });

      await expect(service.delete(400)).rejects.toMatchObject({
        statusCode: 404,
      });

      expect(db.execute).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["storage.deleteCycleCount"]);
    });

    it("executes unfreezeLocations after deleteCycleCount succeeds", async () => {
      const { service, db, callOrder } = makeCycleCountService();

      await expect(service.delete(400)).resolves.toEqual({ success: true });
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["storage.deleteCycleCount", "db.execute"]);
    });
  });

  describe("COUNT-02: complete(id) unfreezes before status flip and UI keeps retry action visible", () => {
    it("does not mark cycle count completed if unfreezeLocations throws", async () => {
      const { service, storage } = makeCycleCountService({
        items: [{ id: 1, cycleCountId: 400, status: "approved", varianceQty: 0 }],
        executeImpl: async () => {
          throw new Error("Transient database connection drop during unfreeze");
        },
      });

      await expect(service.complete(400)).rejects.toThrow(
        "Transient database connection drop during unfreeze",
      );
      expect(storage.updateCycleCount).not.toHaveBeenCalled();
    });

    it("CycleCounts.tsx invalidates /api/cycle-counts on completeMutation error and shows Retry Completion Sync", () => {
      const pagePath = path.resolve(
        __dirname,
        "../../../../../client/src/pages/CycleCounts.tsx",
      );
      const source = fs.readFileSync(pagePath, "utf8");
      expect(source).toContain("Retry Completion Sync");
      expect(source).toContain(
        'cycleCountDetail.status === "completed" && completeMutation.isError',
      );
    });
  });

  describe("COUNT-03: runCycleCountFreezeGuard releases orphaned closed-count freezes and unfreezes before closing", () => {
    it("queries both stale in_progress counts and orphaned freezes on completed/cancelled counts", async () => {
      const executedSql: string[] = [];
      const mockDb = {
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          executedSql.push(text);
          if (executedSql.length === 1) {
            return {
              rows: [
                {
                  location_id: 10,
                  location_code: "A-01-01",
                  cycle_count_id: 501,
                  status: "completed",
                  created_at: new Date(Date.now() - 3600_000).toISOString(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const result = await runCycleCountFreezeGuard(mockDb);
      expect(result).toEqual({ released: 1 });
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(executedSql[0]).toContain("completed");
      expect(executedSql[0]).toContain("cancelled");
      // First write must release warehouse_locations.cycle_count_freeze_id before updating cycle_counts
      expect(executedSql[1]).toContain("warehouse.warehouse_locations");
      expect(executedSql[2]).toContain("inventory.cycle_counts");
    });

    it("unfreezes warehouse_locations before updating cycle_counts so a partial failure never orphans frozen bins", async () => {
      const callOrder: string[] = [];
      const mockDb = {
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          if (text.includes("FROM warehouse.warehouse_locations wl")) {
            callOrder.push("select_candidates");
            return {
              rows: [
                {
                  location_id: 15,
                  location_code: "B-02-01",
                  cycle_count_id: 600,
                  status: "in_progress",
                  created_at: new Date(Date.now() - 72 * 3600_000).toISOString(),
                },
              ],
            };
          }
          if (text.includes("UPDATE warehouse.warehouse_locations")) {
            callOrder.push("unfreeze_locations");
            return { rows: [] };
          }
          if (text.includes("UPDATE inventory.cycle_counts")) {
            callOrder.push("close_cycle_counts");
            throw new Error("DB error on cycle_counts status update");
          }
          return { rows: [] };
        }),
      };

      const result = await runCycleCountFreezeGuard(mockDb);
      expect(result).toEqual({ released: 0 });
      expect(callOrder).toEqual([
        "select_candidates",
        "unfreeze_locations",
        "close_cycle_counts",
      ]);
    });
  });

  describe("COUNT-04: cancel(id) unfreezes before marking status cancelled so retry is not blocked by 409", () => {
    it("does not mark cycle count cancelled when unfreezeLocations fails, allowing clean retry", async () => {
      let attempt = 0;
      const { service, storage, callOrder } = makeCycleCountService({
        executeImpl: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("Deadlock during unfreeze");
          }
          return { rows: [] };
        },
      });

      await expect(service.cancel(400)).rejects.toThrow("Deadlock during unfreeze");
      expect(storage.updateCycleCount).not.toHaveBeenCalled();

      // Retry succeeds because status was not prematurely flipped to 'cancelled'
      await expect(service.cancel(400)).resolves.toEqual({
        success: true,
        linkedReplenBlockersClosed: 0,
      });
      expect(storage.updateCycleCount).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual([
        "db.execute",
        "db.execute",
        "db.execute",
        "storage.updateCycleCount:cancelled",
      ]);
    });
  });

  describe("Cycle count item parent membership & status guards (resetItem / investigateItem)", () => {
    it("rejects resetItem and investigateItem when item belongs to a different cycleCountId", async () => {
      const { service, storage } = makeCycleCountService({
        item: {
          id: 90,
          cycleCountId: 999,
          status: "counted",
        },
      });

      await expect(service.resetItem(400, 90)).rejects.toThrow(
        "Item does not belong to this cycle count",
      );
      await expect(service.investigateItem(400, 90, "admin")).rejects.toThrow(
        "Item does not belong to this cycle count",
      );
      expect(storage.updateCycleCountItem).not.toHaveBeenCalled();
    });

    it("rejects resetItem and investigateItem when parent cycle count is not in_progress", async () => {
      const { service, storage } = makeCycleCountService({
        cycleCount: { id: 400, status: "completed", warehouseId: 1 },
      });

      await expect(service.resetItem(400, 90)).rejects.toThrow(
        "Cannot reset an item for a completed cycle count",
      );
      await expect(service.investigateItem(400, 90, "admin")).rejects.toThrow(
        "Cannot investigate an item for a completed cycle count",
      );
      expect(storage.updateCycleCountItem).not.toHaveBeenCalled();
    });
  });
});

describe("WHS-2 — Warehouse Internal API Boundaries (CI-03)", () => {
  it("exposes bin-assignment, inventory-governance, and cutover-work internal APIs", () => {
    expect(typeof binAssignmentApi.parseBinAssignmentVariantIdsQuery).toBe("function");
    expect(typeof binAssignmentApi.parseBinAssignmentWriteRequest).toBe("function");
    expect(typeof inventoryGovernanceApi.validateWarehouseLocationIntegrity).toBe("function");
    expect(typeof inventoryGovernanceApi.parseWarehouseSettingsWrite).toBe("function");
    expect(typeof cutoverWorkApi.activateReviewedWarehouseSourcesInsideTransaction).toBe("function");
    expect(typeof cutoverWorkApi.validateWarehouseSourceActivation).toBe("function");
    expect(typeof warehouseIndex.validateWarehouseLocationIntegrity).toBe("function");
  });

  it("prevents production modules outside warehouse from deep-importing warehouse domain/work/internal files", () => {
    const modulesRoot = path.resolve(__dirname, "../../..");
    const forbiddenSubstrings = [
      "warehouse/domain/",
      "warehouse/work/",
      "warehouse/location-integrity",
      "warehouse/bin-assignment-filter",
      "warehouse/bin-assignment-contracts",
      "warehouse/infrastructure/warehouse-source-activation.repository",
    ];

    const violations: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const rel = path.relative(modulesRoot, fullPath).replace(/\\/g, "/");
          if (rel.startsWith("warehouse/")) continue;
          const content = fs.readFileSync(fullPath, "utf8");
          for (const forbidden of forbiddenSubstrings) {
            if (content.includes(forbidden)) {
              violations.push(`${rel} -> ${forbidden}`);
            }
          }
        }
      }
    }

    walk(modulesRoot);
    expect(violations).toEqual([]);
  });
});
