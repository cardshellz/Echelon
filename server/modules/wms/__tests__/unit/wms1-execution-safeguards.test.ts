import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { transitionOrderStatus } from "../../../orders/order-status-core";
import { createOrderCombiningService } from "../../../orders/combining.service";
import { startPickingFollowupWorker } from "../../picking-followup.worker";
import { pendingPickingCommandKeys } from "../../picking-command.repository";
import {
  cartonize,
  MAX_CARTONIZE_TOTAL_UNITS,
  type CartonizeBox,
  type CartonizeItem,
} from "../../../cartonization/domain/cartonize";

const repoRoot = resolve(__dirname, "../../../../..");
const readRepoFile = (relPath: string) => readFileSync(resolve(repoRoot, relPath), "utf8");

describe("Priority 10 Batch WMS-1 — Warehouse Execution Safeguards", () => {
  describe("FUL-05: transitionOrderStatus captures true previousStatus", () => {
    it("returns the actual pre-transition status from the atomic CTE when from has multiple states", async () => {
      const db = {
        execute: vi.fn().mockResolvedValue({
          rows: [{ previous_status: "picking", new_status: "cancelled" }],
        }),
      };

      const result = await transitionOrderStatus(db, 77, {
        from: ["ready", "picking", "picked"],
        to: "cancelled",
        reason: "customer_cancelled",
      });

      expect(result.transitioned).toBe(true);
      expect(result.previousStatus).toBe("picking");
      expect(result.newStatus).toBe("cancelled");
    });

    it("removes dead setClauses string construction from order-status-core.ts", () => {
      const src = readRepoFile("server/modules/orders/order-status-core.ts");
      expect(src).toContain("WITH prior AS (");
      expect(src).toContain("RETURNING prior.warehouse_status AS previous_status");
      expect(src).not.toContain("let setClauses");
    });
  });

  describe("PK-01 / OP-01 & PK-05: resolveException and terminal order status guards", () => {
    it("reopens short lines and returns 'resolved' exceptions to the pick queue while guarding terminal orders", () => {
      const storageSrc = readRepoFile("server/modules/orders/orders.storage.ts");
      const start = storageSrc.indexOf("async resolveException(");
      const nextAsync = storageSrc.indexOf("\n  async ", start + 1);
      const resolveBlock = storageSrc.slice(start, nextAsync);

      expect(resolveBlock).toContain("reopenShortWmsOrderItemsForRepick");
      expect(resolveBlock).toContain("order_terminal_status");
      expect(resolveBlock).toContain('notInArray(orders.warehouseStatus, ["shipped", "cancelled"])');
      expect(resolveBlock).toContain('newStatus = allCompleted ? "ready_to_ship" : hasProgress ? "in_progress" : "ready"');
      expect(resolveBlock).toContain("updates.warehouseStatus = newStatus");

      const itemCommandsSrc = readRepoFile("server/modules/wms/order-item-commands.ts");
      expect(itemCommandsSrc).toContain("export async function reopenShortWmsOrderItemsForRepick(");
      expect(itemCommandsSrc).toContain("AND status = 'short'");
    });

    it("guards updateOrderStatus and PUT /api/wms/orders/:id against regressing shipped or cancelled orders", () => {
      const storageSrc = readRepoFile("server/modules/orders/orders.storage.ts");
      const updateStart = storageSrc.indexOf("async updateOrderStatus(");
      const updateEnd = storageSrc.indexOf("async resolveException(", updateStart);
      const updateBlock = storageSrc.slice(updateStart, updateEnd);
      expect(updateBlock).toContain('notInArray(orders.warehouseStatus, ["shipped", "cancelled"])');

      const channelsRoutesSrc = readRepoFile("server/modules/channels/channels.routes.ts");
      const putStart = channelsRoutesSrc.indexOf('app.put("/api/wms/orders/:id"');
      const putBlock = channelsRoutesSrc.slice(putStart, putStart + 800);
      expect(putBlock).toContain('order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled"');
      expect(putBlock).toContain("res.status(409)");
    });
  });

  describe("FW-B3: uncombineOrder terminal status guard and transaction boundary", () => {
    it("rejects uncombining a shipped or cancelled order and runs inside a transaction", async () => {
      let txInvoked = false;
      const dbMock: any = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 101,
                  warehouseStatus: "shipped",
                  combinedGroupId: 5,
                  combinedRole: "child",
                },
              ]),
            }),
          }),
        })),
        update: vi.fn(),
        delete: vi.fn(),
        transaction: vi.fn(async (fn: any) => {
          txInvoked = true;
          return fn(dbMock);
        }),
      };

      const service = createOrderCombiningService(dbMock);
      await expect(service.uncombineOrder(101)).rejects.toThrow(
        "Cannot uncombine order in 'shipped' status",
      );
      expect(txInvoked).toBe(true);
      expect(dbMock.update).not.toHaveBeenCalled();
    });
  });

  describe("PK-04, PK-06, PK-07 & REPL-R1 / REPL-R2: picking and replenishment execution safeguards", () => {
    it("re-checks locked order_items.on_hold inside applyLegacyPickProgressTransaction and persistWmsOnlyPickProgress", () => {
      const pickingSrc = readRepoFile("server/modules/orders/picking.use-cases.ts");
      const legacyStart = pickingSrc.indexOf("private async applyLegacyPickProgressTransaction(");
      const wmsOnlyStart = pickingSrc.indexOf("private async persistWmsOnlyPickProgress(");
      const resolveTargetStart = pickingSrc.indexOf("private async resolvePickTarget(");

      const legacyBlock = pickingSrc.slice(legacyStart, wmsOnlyStart);
      const wmsOnlyBlock = pickingSrc.slice(wmsOnlyStart, resolveTargetStart);

      expect(legacyBlock).toContain("COALESCE(on_hold, false) AS on_hold");
      expect(legacyBlock).toContain('reason: "order_item_on_hold"');
      expect(wmsOnlyBlock).toContain("COALESCE(on_hold, false) AS on_hold");
      expect(wmsOnlyBlock).toContain('reason: "order_item_on_hold"');
    });

    it("guards resolveAllocationWithBin against terminal orders, holds, and partial-pick bin reassignment", () => {
      const pickingSrc = readRepoFile("server/modules/orders/picking.use-cases.ts");
      const start = pickingSrc.indexOf("async resolveAllocationWithBin(");
      const end = pickingSrc.indexOf("async reportReplenSourceEmpty(", start);
      const block = pickingSrc.slice(start, end);

      expect(block).toContain('order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled"');
      expect(block).toContain("order.onHold === 1 || order.orderEditOperationId != null || item.onHold");
      expect(block).toContain("Cannot reassign bin for item");
      expect(block).toContain("unpick first before changing bins");
    });

    it("scopes reportReplenSourceEmpty and recordSourceEmptyBlocker location lookups by warehouseId and wraps blocker creation in a transaction", () => {
      const pickingSrc = readRepoFile("server/modules/orders/picking.use-cases.ts");
      const reportStart = pickingSrc.indexOf("async reportReplenSourceEmpty(");
      const reportEnd = pickingSrc.indexOf("private async getPickSettings(", reportStart);
      const reportBlock = pickingSrc.slice(reportStart, reportEnd);
      expect(reportBlock).toContain("eq(warehouseLocations.warehouseId, order.warehouseId)");

      const replenSrc = readRepoFile("server/modules/inventory/application/replenishment.use-cases.ts");
      const blockerStart = replenSrc.indexOf("async recordSourceEmptyBlocker(");
      const blockerEnd = replenSrc.indexOf("private async createSourceEmptyCycleCount(", blockerStart);
      const blockerBlock = replenSrc.slice(blockerStart, blockerEnd);
      expect(blockerBlock).toContain("pg_advisory_xact_lock(918421");
      expect(blockerBlock).toContain("eq(warehouseLocations.warehouseId, pickLocation.warehouseId)");
    });
  });

  describe("PK-08 / REC-01 / REC-02: followup worker timeout and retry fairness", () => {
    it("times out a hung followup operation and still executes remaining recovery families", async () => {
      const calls: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const worker = startPickingFollowupWorker(
        {
          recoverPendingPickingCommands: () => new Promise<void>(() => {}),
          recoverReplenishmentFollowups: async () => {
            calls.push("replen");
          },
          recoverInventoryTransfers: async () => {
            calls.push("transfers");
          },
          recoverSupplierReturns: async () => {
            calls.push("returns");
          },
        },
        { operationTimeoutMs: 20 },
      );

      await new Promise((r) => setTimeout(r, 80));
      worker.stop();

      expect(calls).toEqual(["replen", "transfers", "returns"]);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("recoverPendingPickingCommands"),
      );
      errSpy.mockRestore();
    });

    it("orders pendingPickingCommandKeys by attempt_count ASC, committed_at ASC, command_key ASC", async () => {
      let capturedSql = "";
      const fakeDb: any = {
        execute: vi.fn(async (query: any) => {
          capturedSql = JSON.stringify(query);
          return { rows: [{ command_key: "wms-pick:00000000-0000-4000-8000-000000000001" }] };
        }),
      };

      const keys = await pendingPickingCommandKeys(fakeDb, 10);
      expect(keys).toEqual(["wms-pick:00000000-0000-4000-8000-000000000001"]);
      expect(capturedSql).toContain("ORDER BY attempt_count ASC, committed_at ASC, command_key ASC");
    });
  });

  describe("FUL-07: cartonize unit-budget guard", () => {
    it("degrades orders exceeding MAX_CARTONIZE_TOTAL_UNITS to fallback parcels with a budget warning", () => {
      const item: CartonizeItem = {
        productVariantId: 10,
        sku: "BULK-SLEEVE",
        quantity: MAX_CARTONIZE_TOTAL_UNITS + 50,
        weightGrams: 10,
        lengthMm: 90,
        widthMm: 65,
        heightMm: 2,
        shippingGroupCode: null,
        shipsInOwnContainer: false,
        riderEligible: false,
        riderVoidCm3: null,
        riderVoidMaxWeightGrams: null,
        riderVoidMaxItems: null,
      };
      const box: CartonizeBox = {
        id: 1,
        code: "BOX-L",
        kind: "box",
        lengthMm: 400,
        widthMm: 300,
        heightMm: 300,
        tareWeightGrams: 200,
        maxWeightGrams: 20_000,
        costCents: 120,
        fillFactorBps: 9000,
        isActive: true,
      };

      const result = cartonize([item], [box]);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("exceeds maximum 3D cartonization unit budget"),
        ]),
      );
      expect(result.candidates[0].parcels[0].placements).toEqual([]);
    });
  });

  describe("OP-02..OP-10: Picking, Replenishment, and PickCorrections operator safeguards", () => {
    it("enforces pre-effect 409 command rejection, fresh item merge, grab-next fresh data, replen guidance error toast, and batch button guard in Picking.tsx", () => {
      const pickingPageSrc = readRepoFile("client/src/pages/Picking.tsx");
      expect(pickingPageSrc).toContain("function isDefiniteCommandRejection(");
      expect(pickingPageSrc).toContain("sourcePlan: apiItem.sourcePlan ?? localItem.sourcePlan");
      expect(pickingPageSrc).toContain("const refreshed = await refetch();");
      expect(pickingPageSrc).toContain('title: "Replenishment check failed"');
      expect(pickingPageSrc).toContain("disabled={queue.length === 0}");
      expect(pickingPageSrc).toContain("disabled={updateItemMutation.isPending || unpickItemMutation.isPending}");
    });

    it("enables Exception button for pending, assigned, and in_progress tasks in Replenishment.tsx and invalidates picking-queue in PickCorrections.tsx", () => {
      const replenPageSrc = readRepoFile("client/src/pages/Replenishment.tsx");
      expect(replenPageSrc).toContain(
        '["pending", "assigned", "in_progress"].includes(task.status) && !noSourceReviewTask',
      );

      const pickCorrectionsSrc = readRepoFile("client/src/features/picking/PickCorrections.tsx");
      expect(pickCorrectionsSrc).toContain('client.invalidateQueries({ queryKey: ["picking-queue"] })');
    });
  });
});
