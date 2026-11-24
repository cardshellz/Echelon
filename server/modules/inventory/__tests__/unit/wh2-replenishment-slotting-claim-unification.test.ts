import { describe, expect, it, vi } from "vitest";

vi.mock("../../../notifications/in-app-notifications.api", () => ({
  notify: vi.fn(async () => undefined),
}));
vi.mock("../../../warehouse/settings.api", () => ({
  getSettingsForWarehouse: vi.fn(async () => ({
    replenMode: "hybrid",
    inlineReplenMaxUnits: 25,
  })),
}));
vi.mock("../../../orders/bin-location-backfill.api", () => ({
  backfillOpenOrderItemBinAssignment: vi.fn(async () => 0),
}));

import { resolveReplenishmentAutoExecution } from "../../domain/replenishment-auto-execution";
import { ReplenishmentUseCases } from "../../application/replenishment.use-cases";
import { legacyTransformationExecutionAuthority } from "../../application/transformation-execution-authority.port";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { createReservationService } from "../../../channels/application/reservation.service";
import { resolveAssignedBinLocation } from "../../../oms/application/wms-sync.service";
import { createBinAssignmentService, relocatePickSlot } from "../../../warehouse/slotting.api";
import {
  inventoryLevels,
  locationReplenConfig,
  productLocations,
  productVariants,
  replenRules,
  replenTasks,
  replenTierDefaults,
  warehouseLocations,
} from "@shared/schema";

describe("WH-2 — Replenishment, Slotting & Claim Unification", () => {
  describe("1. Removal of inlineReplenMaxUnits / inlineReplenMaxCases cap", () => {
    it("auto-executes 100-unit and 1,000-unit case breaks in hybrid and inline modes while honoring queue mode", () => {
      expect(
        resolveReplenishmentAutoExecution(
          0,
          0,
          { replenMode: "hybrid", inlineReplenMaxUnits: 10 },
          100,
          "case_break",
        ),
      ).toEqual({ shouldAutoExecute: true, executionMode: "inline" });

      expect(
        resolveReplenishmentAutoExecution(
          0,
          0,
          { replenMode: "inline" },
          1000,
          "package_conversion",
        ),
      ).toEqual({ shouldAutoExecute: true, executionMode: "inline" });

      expect(
        resolveReplenishmentAutoExecution(
          0,
          0,
          { replenMode: "queue" },
          10,
          "case_break",
        ),
      ).toEqual({ shouldAutoExecute: false, executionMode: "queue" });
    });
  });

  describe("2. Blocked shipment-blocking no_source_stock auto-recovery from Reserve bins", () => {
    it("unblocks blocksShipment=true no_source_stock case_break tasks when stock arrives in a Reserve bin", async () => {
      const updates: Array<{ table: unknown; value: any }> = [];
      const blockedShipmentTask = {
        id: 501,
        revision: 0,
        productId: 10,
        warehouseId: 1,
        fromLocationId: 11,
        toLocationId: 11,
        pickProductVariantId: 100,
        sourceProductVariantId: 200,
        replenMethod: "case_break",
        status: "blocked",
        blocksShipment: true,
        dependsOnTaskId: null,
        exceptionReason: "no_source_stock",
        orderId: 9001,
        orderItemId: 9002,
        orderNumber: "#9001",
        notes: "Blocked: no source stock found",
      };

      const db = {
        select: vi.fn(() => ({
          from: (table: unknown) => ({
            where: vi.fn(() => {
              const rows =
                table === productVariants
                  ? [{ id: 100 }, { id: 200 }]
                  : table === productLocations
                    ? [{ warehouseLocationId: 11 }]
                    : [blockedShipmentTask];
              return {
                limit: vi.fn(async () => rows),
                then: (resolve: (v: any[]) => void, reject?: (e: unknown) => void) =>
                  Promise.resolve(rows).then(resolve, reject),
              };
            }),
          }),
        })),
        update: vi.fn((table: unknown) => ({
          set: vi.fn((value: any) => {
            updates.push({ table, value });
            return {
              where: vi.fn(() => ({
                returning: async () => [{ ...blockedShipmentTask, ...value, revision: 1 }],
                then: (resolve: (v: any[]) => void) => Promise.resolve([]).then(resolve),
              })),
            };
          }),
        })),
        // Reserve bin has is_pickable = 0, location_type = 'reserve'
        execute: vi.fn(async () => ({ rows: [{ is_pickable: 0, location_type: "reserve" }] })),
      };

      const service = new ReplenishmentUseCases(
        db as any,
        {} as any,
        () => new Date("2026-11-24T15:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      const triggerSpy = vi.spyOn(service, "checkAndTriggerAfterPick").mockResolvedValue(null);
      vi.spyOn(service, "checkReplenForLocation").mockResolvedValue(undefined);

      await service.reevaluateReplenForProduct(10);

      const cancelUpdate = updates.find((u) => u.value?.status === "cancelled");
      expect(cancelUpdate?.value).toMatchObject({
        status: "cancelled",
        exceptionReason: "no_source_stock",
        blocksShipment: false,
      });
      expect(triggerSpy).toHaveBeenCalledWith(
        100,
        11,
        "stock_arrival_recovery",
        expect.objectContaining({
          orderId: 9001,
          orderItemId: 9002,
          blocksShipment: true,
          forceWhenAtOrBelowZero: true,
        }),
      );
    });
  });

  describe("3. Proactive demand-driven replenishment & true lot received_at FIFO source selection", () => {
    it("subtracts open order demand from pickBinQty so replenishment triggers before the bin runs dry", async () => {
      const pickLevel = {
        id: 1,
        productVariantId: 100,
        warehouseLocationId: 10,
        variantQty: 12,
        reservedQty: 0,
      };
      const pickLocation = { id: 10, code: "A-01", warehouseId: 1, isPickable: 1, locationType: "pick" };
      const pickVariant = { id: 100, sku: "SKU-EACH", productId: 50, hierarchyLevel: 1, unitsPerVariant: 1 };

      const db = {
        select: vi.fn(() => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: vi.fn(async () => {
                if (table === inventoryLevels) return [pickLevel];
                if (table === warehouseLocations) return [pickLocation];
                if (table === productLocations) return [{ id: 77 }];
                if (table === productVariants) return [pickVariant];
                if (table === locationReplenConfig) return [];
                if (table === replenRules) return [];
                if (table === replenTierDefaults) {
                  return [{ id: 1, hierarchyLevel: 1, triggerValue: 5, maxQty: 25, replenMethod: "full_case", isActive: 1 }];
                }
                return [];
              }),
            }),
          }),
        })),
        // 9 unpicked units on open WMS orders -> projected qty = 12 - 9 = 3 <= triggerValue(5)
        execute: vi.fn(async () => ({ rows: [{ pending_order_units: 9 }] })),
      };

      const service = new ReplenishmentUseCases(
        db as any,
        {} as any,
        () => new Date("2026-11-24T15:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      const ctxRes = await (service as any).loadReplenEvaluationContext(100, 10);
      expect(ctxRes.status).toBe("ready");
      expect(ctxRes.context.evaluatedQty).toBe(3);
    });

    it("de-allocates open replen_tasks source units and selects oldest lot received_at FIFO", async () => {
      const candidates = [
        // Location 201 was updated earlier on inventory_levels, OR has 1 unit already allocated to an open task!
        {
          level: { id: 1, productVariantId: 200, warehouseLocationId: 201, variantQty: 1, reservedQty: 0, updatedAt: new Date("2026-01-01T00:00:00Z") },
          location: { id: 201, code: "R-01", warehouseId: 1, locationType: "reserve", isActive: 1, cycleCountFreezeId: null },
        },
        {
          level: { id: 2, productVariantId: 200, warehouseLocationId: 202, variantQty: 3, reservedQty: 0, updatedAt: new Date("2026-06-01T00:00:00Z") },
          location: { id: 202, code: "R-02", warehouseId: 1, locationType: "reserve", isActive: 1, cycleCountFreezeId: null },
        },
        {
          level: { id: 3, productVariantId: 200, warehouseLocationId: 203, variantQty: 3, reservedQty: 0, updatedAt: new Date("2026-02-01T00:00:00Z") },
          location: { id: 203, code: "R-03", warehouseId: 1, locationType: "reserve", isActive: 1, cycleCountFreezeId: null },
        },
      ];

      let execCount = 0;
      const db = {
        select: vi.fn(() => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: vi.fn(async () => candidates),
              }),
            }),
          }),
        })),
        execute: vi.fn(async () => {
          execCount += 1;
          if (execCount === 1) {
            // R-01's 1 unit is already committed to an open replen task!
            return { rows: [{ from_location_id: 201, allocated_qty: 1 }] };
          }
          // R-02 holds an OLDER physical lot (2026-03-01) than R-03 (2026-08-01), even though R-03's level updatedAt was earlier!
          return {
            rows: [
              { warehouse_location_id: 202, oldest_received_at: "2026-03-01T00:00:00.000Z" },
              { warehouse_location_id: 203, oldest_received_at: "2026-08-01T00:00:00.000Z" },
            ],
          };
        }),
      };

      const service = new ReplenishmentUseCases(
        db as any,
        {} as any,
        () => new Date("2026-11-24T15:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      const chosen = await (service as any).findSourceLocation(200, 1, "reserve", null, "fifo", 1);
      expect(chosen?.code).toBe("R-02");
    });
  });

  describe("4. Canonical claim transformation output lot preserves parent received_at FIFO", () => {
    it("writes oldest source lot received_at onto CLM transformation output lots", async () => {
      const parentReceivedAt = new Date("2026-04-10T08:30:00.000Z");
      const occurredAt = new Date("2026-11-24T15:00:00.000Z");
      const insertedLotParams: any[][] = [];

      const client = {
        query: vi.fn(async (sqlText: string, values?: any[]) => {
          const text = sqlText.trim();
          if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
          if (text.includes("FROM inventory.quantity_ledger_opening")) return { rows: [], rowCount: 0 };
          if (text.startsWith("INSERT INTO inventory.inventory_levels")) return { rows: [], rowCount: 1 };
          if (text.includes("FROM inventory.inventory_levels")) {
            return {
              rows: [
                { id: 11, warehouse_location_id: 2, product_variant_id: 201, variant_qty: 1, reserved_qty: 1 },
                { id: 12, warehouse_location_id: 3, product_variant_id: 101, variant_qty: 0, reserved_qty: 0 },
              ],
            };
          }
          if (text.includes("source.qty_received AS source_qty")) {
            return {
              rows: [
                {
                  source_qty: 1,
                  output_qty: 25,
                  qty_received: 1,
                  cost_precision_version: 1,
                  cost_provisional: 0,
                  total_unit_cost_mills: 25000,
                  unit_cost_mills: 25000,
                  po_unit_cost_mills: 20000,
                  packaging_cost_mills: 3000,
                  landed_cost_mills: 2000,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("FROM inventory.inventory_lots")) {
            if (values?.[0] === 61) {
              return { rows: [{ id: 61, qty_received: 25, status: "active" }], rowCount: 1 };
            }
            return {
              rows: [
                {
                  id: 51,
                  product_variant_id: 201,
                  warehouse_location_id: 2,
                  qty_received: 1,
                  qty_on_hand: 1,
                  qty_reserved: 1,
                  qty_picked: 0,
                  status: "active",
                  received_at: parentReceivedAt,
                  unit_cost_mills: "25000",
                  po_unit_cost_mills: "20000",
                  packaging_cost_mills: "3000",
                  landed_cost_mills: "2000",
                  total_unit_cost_mills: "25000",
                },
              ],
              rowCount: 1,
            };
          }
          if (text.startsWith("INSERT INTO inventory.inventory_lots")) {
            insertedLotParams.push(values ?? []);
            return { rows: [{ id: 61 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }),
      };

      const repo = new PostgresCanonicalClaimInventoryRepository();
      await repo.executePackageOperation({
        client: client as any,
        claimId: BigInt(99),
        claimOperationId: BigInt(7),
        operationKey: "line:1:break:1",
        operationType: "break_pack",
        resources: [
          {
            claimResourceId: BigInt(1),
            inventoryLevelId: 11,
            warehouseLocationId: 2,
            sourceVariantId: 201,
            consumeQty: BigInt(1),
            lotAllocations: [
              {
                claimLotAllocationId: BigInt(5),
                inventoryLotId: 51,
                consumeQty: BigInt(1),
                unitCostMills: BigInt(25000),
                poUnitCostMills: BigInt(20000),
                packagingUnitCostMills: BigInt(3000),
                landedUnitCostMills: BigInt(2000),
              },
            ],
          },
        ],
        destinationVariantId: 101,
        outputLocationId: 3,
        outputQty: BigInt(25),
        committedOutputQty: BigInt(25),
        orderId: 500,
        orderItemId: 600,
        actor: "picker:1",
        reason: "inline case break",
        occurredAt,
      });

      expect(insertedLotParams.length).toBeGreaterThan(0);
      // $17 (last param on non-build lot insert) is outputLotReceivedAt === parentReceivedAt
      expect(insertedLotParams[0].at(-1)).toEqual(parentReceivedAt);
      // $14 (created_at) remains occurredAt
      expect(insertedLotParams[0][13]).toEqual(occurredAt);
    });
  });

  describe("5. 0-stock primary pick bin reservation safety (never violates check_reserved_lte_on_hand)", () => {
    it("InventoryUseCases.reserveForOrder returns false instead of incrementing reservedQty past variantQty", async () => {
      const adjustInventoryLevel = vi.fn();
      const storage = {
        upsertInventoryLevel: vi.fn(async () => ({
          id: 42,
          productVariantId: 101,
          warehouseLocationId: 10,
          variantQty: 0,
          reservedQty: 0,
        })),
        adjustInventoryLevel,
        createInventoryTransaction: vi.fn(),
      };
      const db = {
        execute: vi.fn(async () => ({ rows: [] })),
        transaction: async (fn: any) => fn(db),
      };
      const core = new InventoryUseCases(db as any, storage as any);

      const ok = await core.reserveForOrder({
        productVariantId: 101,
        warehouseLocationId: 10,
        qty: 2,
        orderId: 700,
        orderItemId: 701,
      });

      expect(ok).toBe(false);
      expect(adjustInventoryLevel).not.toHaveBeenCalled();
    });

    it("ReservationService admits 0-stock Each pick bin backed by Reserve Case ATP as promised (shortfall = 0)", async () => {
      const mockInventoryCore = {
        // Simulates real InventoryUseCases.reserveForOrder returning false on 0-stock pick bin A-01
        reserveForOrder: vi.fn(async () => false),
      };
      const mockChannelSync = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
      const mockAtpService = {
        getAtpPerVariant: vi.fn(async () => [
          { productVariantId: 101, sku: "SKU-EACH", atpUnits: 25, unitsPerVariant: 1 },
        ]),
        getProductInventoryStrategy: vi.fn(async () => "physical_fungible"),
      };
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn()
          .mockResolvedValueOnce([{ productId: 50, requiresShipping: true, trackInventory: true }])
          .mockResolvedValueOnce([{ warehouseLocationId: 10 }]),
      };
      const mockDb: any = {
        select: vi.fn(() => selectChain),
        execute: vi.fn(async () => ({ rows: [] })),
        transaction: async (fn: any) => fn(mockDb),
      };

      const svc = createReservationService(mockDb, mockInventoryCore as any, mockChannelSync as any, mockAtpService as any);
      const res = await svc.reserveForOrder(50, 101, 4, 800, 801);

      expect(res).toEqual({ reserved: 0, promised: 4, shortfall: 0 });
    });

    it("ReservationService reserves partial direct units at A-01 and promises the Case-backed remainder", async () => {
      const reserveCalls: any[] = [];
      const mockInventoryCore = {
        reserveForOrder: vi.fn(async (params: any) => {
          reserveCalls.push(params);
          return true;
        }),
      };
      const mockChannelSync = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
      const mockAtpService = {
        getAtpPerVariant: vi.fn(async () => [
          { productVariantId: 101, sku: "SKU-EACH", atpUnits: 26, unitsPerVariant: 1 },
        ]),
        getProductInventoryStrategy: vi.fn(async () => "physical_fungible"),
      };
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn()
          .mockResolvedValueOnce([{ productId: 50, requiresShipping: true, trackInventory: true }])
          .mockResolvedValueOnce([{ warehouseLocationId: 10 }]),
      };
      const mockDb: any = {
        select: vi.fn(() => selectChain),
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          if (text.includes("unreserved_qty")) {
            return { rows: [{ warehouse_location_id: 10, unreserved_qty: 1, is_pickable: 1 }] };
          }
          return { rows: [] };
        }),
        transaction: async (fn: any) => fn(mockDb),
      };

      const svc = createReservationService(mockDb, mockInventoryCore as any, mockChannelSync as any, mockAtpService as any);
      const res = await svc.reserveForOrder(50, 101, 5, 800, 801);

      expect(res).toEqual({ reserved: 1, promised: 4, shortfall: 0 });
      expect(reserveCalls).toHaveLength(1);
      expect(reserveCalls[0]).toMatchObject({ warehouseLocationId: 10, qty: 1 });
    });
  });

  describe("6. Warehouse-scoped order-line bin resolution & atomic Move Slot & Stock Together", () => {
    it("resolveAssignedBinLocation selects the primary pick bin in the order's warehouse", async () => {
      const fakeDb: any = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: async () => [
                {
                  slotId: 1,
                  slotStatus: "active",
                  isPrimary: 1,
                  code: "WH1-A-01",
                  warehouseId: 1,
                  warehouseZone: "A",
                  productZone: "A",
                  locationIsActive: 1,
                  locationIsPickable: 1,
                  locationType: "pick",
                  cycleCountFreezeId: null,
                },
                {
                  slotId: 2,
                  slotStatus: "active",
                  isPrimary: 1,
                  code: "WH2-B-04",
                  warehouseId: 2,
                  warehouseZone: "B",
                  productZone: "B",
                  locationIsActive: 1,
                  locationIsPickable: 1,
                  locationType: "pick",
                  cycleCountFreezeId: null,
                },
              ],
            }),
          }),
        }),
      };

      await expect(resolveAssignedBinLocation(fakeDb, 101, 2)).resolves.toEqual({
        location: "WH2-B-04",
        zone: "B",
      });
    });

    it("relocatePickSlot atomically transfers stock+reservations, updates primary slot, and migrates replen + order pointers", async () => {
      const transferCalls: any[] = [];
      const setCalls: any[] = [];
      const tx = {
        execute: vi.fn(async (q: any) => {
          const text = JSON.stringify(q);
          if (text.includes("source_code")) {
            return { rows: [{ id: 55, warehouse_location_id: 10, source_code: "A-01", source_warehouse_id: 1, source_freeze_id: null }] };
          }
          if (text.includes("SELECT variant_qty")) {
            return { rows: [{ variant_qty: 14 }] };
          }
          if (text.includes("to_regclass")) {
            return { rows: [{ reg: "present" }] };
          }
          if (text.includes("UPDATE inventory.location_replen_config")) {
            return { rows: [{ id: 8 }] };
          }
          if (text.includes("UPDATE inventory.replen_tasks")) {
            return { rows: [{ id: 21 }, { id: 22 }] };
          }
          if (text.includes("UPDATE wms.order_items")) {
            return { rows: [{ id: 301 }], rowCount: 1 };
          }
          return { rows: [] };
        }),
        update: vi.fn(() => ({
          set: vi.fn((vals: any) => {
            setCalls.push(vals);
            return {
              where: vi.fn(() => ({
                returning: vi.fn(async () => [{ id: 55, sku: "SKU-EACH", location: "A-09", zone: "A", ...vals }]),
              })),
            };
          }),
        })),
        insert: vi.fn(),
      };
      const db: any = {
        transaction: async (fn: any) => fn(tx),
      };
      const storage: any = {
        getWarehouseLocationById: vi.fn(async (id: number) =>
          id === 10
            ? { id: 10, code: "A-01", zone: "A", warehouseId: 1, isActive: 1, isPickable: 1, locationType: "pick", cycleCountFreezeId: null }
            : { id: 20, code: "A-09", zone: "A", warehouseId: 1, isActive: 1, isPickable: 1, locationType: "pick", cycleCountFreezeId: null },
        ),
        getProductVariantById: vi.fn(async () => ({ id: 101, productId: 50, sku: "SKU-EACH", name: "Each", barcode: "123" })),
        getProductById: vi.fn(async () => ({ id: 50, name: "Card Sleeve", sku: "SKU-EACH" })),
        getProductLocationById: vi.fn(),
        getProductVariantBySku: vi.fn(),
        getWarehouseLocationByCode: vi.fn(),
        deleteProductLocation: vi.fn(),
      };
      const inventoryOwner = {
        transfer: vi.fn(),
        withTx: vi.fn(() => ({
          transfer: vi.fn(async (params: any) => {
            transferCalls.push(params);
            return { reservedMoved: 4, orderItemsRepointed: 2, transferReceiptId: 999 };
          }),
        })),
        publishInventoryChange: vi.fn(async () => undefined),
      };

      const svc = createBinAssignmentService(db, storage, inventoryOwner);
      const result = await relocatePickSlot(svc, {
        productVariantId: 101,
        fromLocationId: 10,
        toLocationId: 20,
        moveStock: true,
        userId: "admin-1",
      });

      expect(transferCalls).toHaveLength(1);
      expect(transferCalls[0]).toMatchObject({
        productVariantId: 101,
        fromLocationId: 10,
        toLocationId: 20,
        qty: 14,
        moveReserved: true,
        referenceType: "slot_relocation",
      });
      expect(setCalls[0]).toMatchObject({
        warehouseLocationId: 20,
        location: "A-09",
        isPrimary: 1,
        status: "active",
      });
      expect(result).toMatchObject({
        fromLocationId: 10,
        toLocationId: 20,
        movedQty: 14,
        movedReservedQty: 4,
        migratedReplenConfigs: 1,
        migratedReplenTasks: 2,
        repointedOrderItems: 1,
        transferReceiptId: 999,
      });
    });
  });
});
