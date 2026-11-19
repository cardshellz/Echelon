import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  parseWarehouseLocationId,
  parseWarehouseLocationPatch,
  WarehouseLocationWriteError,
} from "../../domain/warehouse-location-write";
import {
  assertPickFaceAssignmentEligible,
  normalizeLocationPatchInput,
  validateWarehouseLocationIntegrity,
} from "../../location-integrity";
import {
  bulkReassignProducts,
  updateWarehouseLocation,
} from "../../infrastructure/warehouse.repository";
import { BinAssignmentService } from "../../bin-assignment.service";
import { backfillOpenOrderItemBinAssignment } from "../../../orders/bin-location-backfill";
import {
  backfillUnassignedWmsOrderItemBin,
  setWmsOrderItemLocation,
} from "../../../wms/order-item-commands";

function sqlTextOf(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
        return (chunk as any).value.join("");
      }
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).queryChunks)) {
        return sqlTextOf(chunk);
      }
      return "";
    })
    .join("");
}

describe("Priority 5 Batch WHS-1 — Warehouse Setup, Slotting & Metadata Safeguards", () => {
  describe("WH-F01: Strict allowlist for location metadata PATCH", () => {
    it("accepts the 11 allowed editor fields and normalizes locationType and binType", () => {
      const parsed = parseWarehouseLocationPatch({
        locationType: "bin",
        binType: "PALLET",
        isPickable: 1,
        zone: " fwd ",
        aisle: " A ",
        bay: "02",
        level: "B",
        bin: "1",
        name: " Front Pallet ",
        warehouseId: 2,
        isActive: 1,
      });

      expect(parsed).toEqual({
        locationType: "pick",
        binType: "pallet",
        isPickable: 1,
        zone: "fwd",
        aisle: "A",
        bay: "02",
        level: "B",
        bin: "1",
        name: "Front Pallet",
        warehouseId: 2,
        isActive: 1,
      });
    });

    it("rejects cycleCountFreezeId modifications via location metadata PATCH", () => {
      expect(() =>
        parseWarehouseLocationPatch({
          name: "Attempted unfreeze",
          cycleCountFreezeId: null,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "WarehouseLocationWriteError",
          code: "WAREHOUSE_LOCATION_FREEZE_PROTECTED",
          statusCode: 400,
        }),
      );
    });

    it.each([
      { id: 99, name: "Rename" },
      { code: "CUSTOM-CODE", name: "Rename" },
      { createdAt: "2026-01-01", name: "Rename" },
      { updatedAt: "2026-01-01", name: "Rename" },
      { unknownKey: true, name: "Rename" },
    ])("rejects protected or unknown field %j before touching storage", (payload) => {
      expect(() => parseWarehouseLocationPatch(payload)).toThrowError(WarehouseLocationWriteError);
    });

    it("rejects empty payloads and invalid location IDs", () => {
      expect(() => parseWarehouseLocationPatch({})).toThrowError(
        expect.objectContaining({ code: "WAREHOUSE_LOCATION_PATCH_EMPTY" }),
      );
      expect(() => parseWarehouseLocationId("0")).toThrowError(
        expect.objectContaining({ code: "WAREHOUSE_LOCATION_ID_INVALID" }),
      );
      expect(() => parseWarehouseLocationId("-5")).toThrowError(
        expect.objectContaining({ code: "WAREHOUSE_LOCATION_ID_INVALID" }),
      );
      expect(parseWarehouseLocationId("42")).toBe(42);
    });
  });

  describe("WH-F02: Partial update normalization preserves omitted locationType and freeze", () => {
    it("does not inject locationType='pick' when locationType is omitted", () => {
      const patch = normalizeLocationPatchInput({ name: "Updated Reserve", isActive: 0 });
      expect(patch).toEqual({ name: "Updated Reserve", isActive: 0 });
      expect("locationType" in patch).toBe(false);
    });

    it("updates an active reserve location's name or active status without converting it to pick or clearing freeze", async () => {
      const existingReserve = {
        id: 11,
        warehouseId: 1,
        zone: "RES",
        aisle: "A",
        bay: "01",
        level: "B",
        bin: "1",
        code: "RES-A-01-B-1",
        name: "Old Reserve",
        locationType: "reserve",
        binType: "pallet",
        isPickable: 0,
        isActive: 1,
        cycleCountFreezeId: 77,
      };

      const setPayloads: Record<string, unknown>[] = [];
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(async () => [existingReserve]),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((vals: Record<string, unknown>) => {
            setPayloads.push(vals);
            return {
              where: vi.fn(() => ({
                returning: vi.fn(async () => [{ ...existingReserve, ...vals }]),
              })),
            };
          }),
        })),
      };

      const renamed = await updateWarehouseLocation(11, { name: "New Reserve" }, tx as any);
      expect(renamed?.name).toBe("New Reserve");
      expect(renamed?.locationType).toBe("reserve");
      expect(renamed?.cycleCountFreezeId).toBe(77);
      expect(setPayloads[0]).not.toHaveProperty("locationType");
      expect(setPayloads[0]).not.toHaveProperty("cycleCountFreezeId");

      const deactivated = await updateWarehouseLocation(11, { isActive: 0 }, tx as any);
      expect(deactivated?.isActive).toBe(0);
      expect(deactivated?.locationType).toBe("reserve");
      expect(setPayloads[1]).not.toHaveProperty("locationType");
    });

    it("rejects direct repository update attempts that include cycleCountFreezeId", async () => {
      const tx = { select: vi.fn(), update: vi.fn() };
      await expect(
        updateWarehouseLocation(11, { cycleCountFreezeId: null } as any, tx as any),
      ).rejects.toThrow(/Cannot modify protected field\(s\) via location metadata update: cycleCountFreezeId/);
      expect(tx.select).not.toHaveBeenCalled();
    });
  });

  describe("WH-F03 & CI-02: Target pick-face eligibility & bulkReassignProducts backfill", () => {
    it("assertPickFaceAssignmentEligible rejects inactive, orphan, non-pick, and frozen locations", () => {
      expect(() =>
        assertPickFaceAssignmentEligible({
          code: "A-01",
          isActive: 0,
          warehouseId: 1,
          locationType: "pick",
          isPickable: 1,
        }),
      ).toThrow(/inactive/);

      expect(() =>
        assertPickFaceAssignmentEligible({
          code: "A-01",
          isActive: 1,
          warehouseId: null,
          locationType: "pick",
          isPickable: 1,
        }),
      ).toThrow(/not assigned to a warehouse/);

      expect(() =>
        assertPickFaceAssignmentEligible({
          code: "RES-01",
          isActive: 1,
          warehouseId: 1,
          locationType: "reserve",
          isPickable: 0,
        }),
      ).toThrow(/not a pick face/);

      expect(() =>
        assertPickFaceAssignmentEligible({
          code: "A-01",
          isActive: 1,
          warehouseId: 1,
          locationType: "pick",
          isPickable: 1,
          cycleCountFreezeId: 19,
        }),
      ).toThrow(/frozen for cycle count/);
    });

    it("bulkReassignProducts rejects non-pick target locations before updating product_locations", async () => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(async () => [
              {
                id: 50,
                code: "RES-01",
                zone: "RES",
                warehouseId: 1,
                isActive: 1,
                locationType: "reserve",
                isPickable: 0,
                cycleCountFreezeId: null,
              },
            ]),
          })),
        })),
        update: vi.fn(),
      };

      await expect(
        bulkReassignProducts([10, 11], 50, "RES-01", "RES", tx as any),
      ).rejects.toThrow(/not a pick face/);
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe("WHM-02: Warehouse-scoped unassigned open order item bin backfill", () => {
    it("scopes backfillUnassignedWmsOrderItemBin SQL by warehouseId when provided", async () => {
      const execute = vi.fn(async (_q: any) => ({ rows: [{ id: 101 }] }));
      const count = await backfillUnassignedWmsOrderItemBin(
        { execute } as any,
        {
          sku: "SHLZ-TOP-35PT",
          locationCode: "FWD-A-01-B-1",
          zone: "FWD",
          warehouseId: 2,
        },
      );

      expect(count).toBe(1);
      const sqlText = sqlTextOf(execute.mock.calls[0][0]);
      expect(sqlText).toContain("AND (o.warehouse_id = ");
      expect(sqlText).toContain("OR o.warehouse_id IS NULL)");
    });

    it("threads warehouseId from backfillOpenOrderItemBinAssignment to backfillUnassignedWmsOrderItemBin", async () => {
      const execute = vi.fn(async (_q: any) => ({ rows: [{ id: 202 }] }));
      const updated = await backfillOpenOrderItemBinAssignment(
        {
          sku: "SHLZ-TOP-35PT",
          locationCode: "FWD-A-01-B-1",
          zone: "FWD",
          warehouseId: 3,
        },
        { execute } as any,
      );

      expect(updated).toBe(1);
      const sqlText = sqlTextOf(execute.mock.calls[0][0]);
      expect(sqlText).toContain("AND (o.warehouse_id = ");
    });

    it("blocks BinAssignmentService.assignVariantToLocation when target bin is frozen for cycle count", async () => {
      const storage = {
        getProductVariantById: vi.fn(async () => ({
          id: 206,
          productId: 91,
          sku: "SHLZ-TOP-35PT-BLU-C1000",
        })),
        getWarehouseLocationById: vi.fn(async () => ({
          id: 1354,
          code: "A-01-B-1",
          locationType: "pick",
          isPickable: 1,
          isActive: 1,
          warehouseId: 1,
          cycleCountFreezeId: 88,
        })),
      };
      const service = new BinAssignmentService({} as any, storage as any);

      await expect(
        service.assignVariantToLocation({
          productVariantId: 206,
          warehouseLocationId: 1354,
        }),
      ).rejects.toThrow(/frozen for cycle count/);
    });
  });

  describe("WHM-04: Conditional pending-unpicked guard on setWmsOrderItemLocation", () => {
    it("returns null without overwriting when onlyIfPendingUnpicked is true and concurrent pick progressed", async () => {
      const whereCalls: unknown[] = [];
      const executor = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn((clause: unknown) => {
              whereCalls.push(clause);
              return {
                returning: vi.fn(async () => []),
              };
            }),
          })),
        })),
      };

      const result = await setWmsOrderItemLocation(executor as any, {
        itemId: 501,
        location: "FWD-A-01",
        zone: "FWD",
        onlyIfPendingUnpicked: true,
      });

      expect(result).toBeNull();
      expect(whereCalls).toHaveLength(1);
    });
  });

  describe("WHM-03, WHM-05, CI-02, CI-07: Route-level safeguards in warehouse.routes.ts and locations.routes.ts", () => {
    const warehouseRoutesSrc = readFileSync(
      resolve(__dirname, "../../warehouse.routes.ts"),
      "utf-8",
    );
    const locationsRoutesSrc = readFileSync(
      resolve(__dirname, "../../locations.routes.ts"),
      "utf-8",
    );

    it("gates POST /api/locations/sync-to-queue with requirePermission('inventory', 'edit') and onlyIfPendingUnpicked", () => {
      expect(locationsRoutesSrc).toContain(
        'app.post("/api/locations/sync-to-queue", requirePermission("inventory", "edit")',
      );
      expect(locationsRoutesSrc).toContain("onlyIfPendingUnpicked: true");
    });

    it("removes dead ensureWarehouseLocation helper from locations.routes.ts (CI-07)", () => {
      expect(locationsRoutesSrc).not.toContain("ensureWarehouseLocation");
    });

    it("wraps POST /api/locations/:id/move update and audit transaction inside db.transaction with pick-face check (CI-02)", () => {
      const moveIdx = locationsRoutesSrc.indexOf('app.post("/api/locations/:id/move"');
      expect(moveIdx).toBeGreaterThan(-1);
      const moveBlock = locationsRoutesSrc.slice(moveIdx, moveIdx + 2400);
      expect(moveBlock).toContain("assertPickFaceAssignmentEligible(targetLocation)");
      expect(moveBlock).toContain("await db.transaction(async (tx) =>");
      expect(moveBlock).toContain("storage.updateProductLocation(");
      expect(moveBlock).toContain("storage.createInventoryTransaction(");
    });

    it("parses PATCH /api/warehouse/locations/:id via parseWarehouseLocationPatch and preserves binType in bulk-import (WH-F01, WHM-05)", () => {
      expect(warehouseRoutesSrc).toContain("parseWarehouseLocationPatch(req.body)");
      expect(warehouseRoutesSrc).toContain(
        'binType: (loc.binType || loc.bin_type || existing?.binType || "bin")',
      );
    });
  });
});
