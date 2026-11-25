import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { AppError } from "@shared/errors";
import { InventoryUseCases, FreezeViolationError } from "../../application/inventory.use-cases";
import { CycleCountUseCases } from "../../application/cycle-count.use-cases";
import { InterwarehouseTransferService } from "../../application/interwarehouse-transfer.service";
import { reportReplenishmentException } from "../../application/report-replenishment-exception";
import { BuildExecutionRepository } from "../../infrastructure/build-execution.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import {
  closeInterwarehouseTransitLocationInWarehouse,
  freezeWarehouseLocationsChunkForCycleCountInWarehouse,
} from "../../../warehouse/cross-module-warehouse-mutations.api";

vi.mock("../../infrastructure/operational-quantity-posting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/operational-quantity-posting")>()),
  openOperationalQuantityPosting: vi.fn(async () => null),
  CanonicalClaimQuantityPosting: {
    forCommand: vi.fn(async () => null),
  },
}));
vi.mock("../../../procurement/receiving-custody.api", () => ({
  readUnresolvedReceivingCustody: vi.fn(async () => []),
}));
vi.mock("../../../warehouse/cross-module-warehouse-mutations.api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../warehouse/cross-module-warehouse-mutations.api")>()),
  closeInterwarehouseTransitLocationInWarehouse: vi.fn(async () => true),
  freezeWarehouseLocationsChunkForCycleCountInWarehouse: vi.fn(async () => undefined),
}));
vi.mock("../../../../infrastructure/auditLogger", () => ({
  persistAuditEvent: vi.fn(async () => undefined),
  AuditLogger: { log: vi.fn(async () => undefined) },
}));
vi.mock("../../../../platform/commands/command-results.repository", () => ({
  createDrizzleFinancialCommandRepository: vi.fn((database: any) => ({ __db: database })),
}));
vi.mock("../../../../platform/commands/transactional-command.service", () => ({
  runTransactionalFinancialCommand: vi.fn(async ({ repository, work, classifyFailure }: any) => {
    try {
      const outcome = await repository.__db.transaction(work);
      return {
        terminalState: "completed",
        httpStatus: 200,
        body: outcome.body,
      };
    } catch (err) {
      const classified = classifyFailure?.(err);
      if (classified?.kind === "rejected") {
        return {
          terminalState: "rejected",
          httpStatus: classified.httpStatus,
          body: classified.body,
        };
      }
      throw err;
    }
  }),
}));

const fixedNow = new Date("2026-11-24T20:00:00.000Z");

describe("WH-5: Cycle Count Transfer/Bulk-Approve, Freeze Parity & Interwarehouse Cancel", () => {
  describe("InventoryUseCases freeze parity & cycle-count-authorized transfer", () => {
    function makeInventoryHarness(opts: {
      fromFreezeId?: number | null;
      toFreezeId?: number | null;
      cycleCountStatus?: string | null;
      reservedQty?: number;
      toLocationType?: string;
    } = {}) {
      const createdTransactions: any[] = [];
      const reserved = opts.reservedQty ?? 0;
      const mockStorage: any = {
        upsertInventoryLevel: vi.fn(() =>
          Promise.resolve({ id: 1, variantQty: 20, reservedQty: reserved, pickedQty: 5 }),
        ),
        adjustInventoryLevel: vi.fn(() => Promise.resolve()),
        lockInventoryLevel: vi.fn(() =>
          Promise.resolve({ id: 1, variantQty: 20, reservedQty: reserved, pickedQty: 5 }),
        ),
        createInventoryTransaction: vi.fn((t: any) => {
          createdTransactions.push(t);
          return Promise.resolve({ id: 900 + createdTransactions.length, ...t });
        }),
      };

      const makeTx = () => {
        let locationSelectCount = 0;
        return {
          select: vi.fn(() => {
            let tableName = "";
            return {
              from: vi.fn((tbl: any) => {
                tableName = tbl?.[Symbol.for("drizzle:Name")] ?? "";
                return {
                  where: vi.fn(() => ({
                    limit: vi.fn(async () => {
                      if (tableName === "product_variants") {
                        return [{ id: 1, unitsPerVariant: 1, sku: "SKU-1" }];
                      }
                      locationSelectCount += 1;
                      if (locationSelectCount === 1) {
                        return [
                          {
                            id: 5,
                            code: "A-01",
                            warehouseId: 1,
                            isActive: 1,
                            isPickable: 1,
                            locationType: "pick",
                            cycleCountFreezeId: opts.fromFreezeId ?? null,
                          },
                        ];
                      }
                      return [
                        {
                          id: 6,
                          code: "B-02",
                          warehouseId: 1,
                          isActive: 1,
                          isPickable: (opts.toLocationType ?? "reserve") === "pick" ? 1 : 0,
                          locationType: opts.toLocationType ?? "reserve",
                          cycleCountFreezeId: opts.toFreezeId ?? null,
                        },
                      ];
                    }),
                  })),
                };
              }),
            };
          }),
          execute: vi.fn(async (query: any) => {
            const { sql } = new PgDialect().sqlToQuery(query);
            if (sql.includes("FROM inventory.cycle_counts")) {
              return opts.cycleCountStatus
                ? { rows: [{ id: 77, status: opts.cycleCountStatus }] }
                : { rows: [] };
            }
            return { rows: [] };
          }),
        };
      };

      const mockDb: any = {
        select: vi.fn(() => makeTx().select()),
        execute: vi.fn(async (q: any) => makeTx().execute(q)),
        transaction: async (fn: any) => fn(makeTx()),
      };

      const lotService: any = {
        withTx: vi.fn(() => ({
          transferLots: vi.fn(async () => []),
        })),
      };

      const uc = new InventoryUseCases(mockDb, mockStorage, lotService);
      return { uc, mockStorage, createdTransactions };
    }

    it("rejects pickItem on a frozen bin with FreezeViolationError", async () => {
      const { uc } = makeInventoryHarness({ fromFreezeId: 77 });
      await expect(
        uc.pickItem({
          productVariantId: 1,
          warehouseLocationId: 5,
          qty: 2,
          orderId: 100,
          orderItemId: 200,
        }),
      ).rejects.toThrow(FreezeViolationError);
    });

    it("rejects unpickItem on a frozen bin with FreezeViolationError", async () => {
      const { uc } = makeInventoryHarness({ fromFreezeId: 77 });
      await expect(
        uc.unpickItem({
          productVariantId: 1,
          warehouseLocationId: 5,
          qty: 2,
          orderId: 100,
          orderItemId: 200,
        }),
      ).rejects.toThrow(FreezeViolationError);
    });

    it("allows transfer between bins frozen by the matching in_progress cycleCountId and stamps cycleCountId", async () => {
      const { uc, createdTransactions } = makeInventoryHarness({
        fromFreezeId: 77,
        toFreezeId: 77,
        cycleCountStatus: "in_progress",
      });

      const res = await uc.transfer({
        commandKey: "cc-transfer:77:item:10:from:5:to:6:qty:4",
        cycleCountId: 77,
        productVariantId: 1,
        fromLocationId: 5,
        toLocationId: 6,
        qty: 4,
        referenceType: "cycle_count",
        referenceId: "77",
      });

      expect(res.transferReceiptId).toBeGreaterThan(0);
      expect(createdTransactions).toHaveLength(1);
      expect(createdTransactions[0].transactionType).toBe("transfer");
      expect(createdTransactions[0].cycleCountId).toBe(77);
    });

    it("rejects cycle-count transfer when a bin is frozen by a DIFFERENT cycle count", async () => {
      const { uc } = makeInventoryHarness({
        fromFreezeId: 77,
        toFreezeId: 88,
        cycleCountStatus: "in_progress",
      });

      await expect(
        uc.transfer({
          commandKey: "cc-transfer:77:conflict",
          cycleCountId: 77,
          productVariantId: 1,
          fromLocationId: 5,
          toLocationId: 6,
          qty: 4,
        }),
      ).rejects.toThrow(FreezeViolationError);
    });

    it("rejects cycle-count transfer when the cycle count is not in_progress", async () => {
      const { uc } = makeInventoryHarness({
        fromFreezeId: 77,
        toFreezeId: 77,
        cycleCountStatus: "completed",
      });

      await expect(
        uc.transfer({
          commandKey: "cc-transfer:77:closed",
          cycleCountId: 77,
          productVariantId: 1,
          fromLocationId: 5,
          toLocationId: 6,
          qty: 4,
        }),
      ).rejects.toMatchObject({ code: "CYCLE_COUNT_NOT_IN_PROGRESS", statusCode: 409 });
    });
  });

  describe("CycleCountUseCases.resolveWithTransfer & bulkApprove", () => {
    it("routes resolveWithTransfer through canonical transferStock with cycleCountId, deterministic commandKey, and auto-resolves both partner items", async () => {
      const items = new Map<number, any>([
        [
          10,
          {
            id: 10,
            cycleCountId: 77,
            warehouseLocationId: 5,
            productVariantId: 101,
            expectedSku: "SKU-A",
            expectedQty: 10,
            countedSku: "SKU-A",
            countedQty: 6,
            varianceQty: -4,
            varianceType: "quantity_under",
            varianceNotes: null,
            status: "variance",
          },
        ],
        [
          11,
          {
            id: 11,
            cycleCountId: 77,
            warehouseLocationId: 6,
            productVariantId: 101,
            expectedSku: "SKU-A",
            expectedQty: 2,
            countedSku: "SKU-A",
            countedQty: 6,
            varianceQty: 4,
            varianceType: "quantity_over",
            varianceNotes: null,
            status: "variance",
          },
        ],
      ]);

      const mockStorage: any = {
        getCycleCountById: vi.fn(async () => ({ id: 77, status: "in_progress", warehouseId: 1 })),
        getCycleCountItemById: vi.fn(async (id: number) => items.get(id) ?? null),
        getCycleCountItems: vi.fn(async () => Array.from(items.values())),
        getWarehouseLocationById: vi.fn(async (id: number) =>
          id === 5 ? { id: 5, code: "A-01" } : { id: 6, code: "B-02" },
        ),
        updateCycleCountItem: vi.fn(async (id: number, patch: any) => {
          const cur = items.get(id);
          if (cur) items.set(id, { ...cur, ...patch });
        }),
        updateCycleCount: vi.fn(async () => undefined),
      };

      const mockDb: any = {
        execute: vi.fn(async () => ({ rows: [] })),
      };

      const transferCalls: any[] = [];
      const mockInventoryUseCases: any = {
        transfer: vi.fn(async (params: any) => {
          transferCalls.push(params);
          return { reservedMoved: 0, orderItemsRepointed: 0, transferReceiptId: 555 };
        }),
      };

      const mockChannelSync: any = {
        queueSyncAfterInventoryChange: vi.fn(async () => undefined),
      };

      const cc = new CycleCountUseCases(
        mockDb,
        mockInventoryUseCases,
        mockChannelSync,
        {} as any,
        mockStorage,
        {} as any,
      );
      vi.spyOn(cc as any, "refreshBinStats").mockResolvedValue(undefined);

      const result = await cc.resolveWithTransfer(
        77,
        10,
        { destinationLocationId: 6, direction: "from_item", qty: 4, notes: "Found in B-02" },
        "manager-1",
      );

      expect(transferCalls).toHaveLength(1);
      expect(transferCalls[0]).toMatchObject({
        commandKey: "cc-resolve-transfer:77:item:10:from:5:to:6:qty:4:exp:10",
        cycleCountId: 77,
        productVariantId: 101,
        fromLocationId: 5,
        toLocationId: 6,
        qty: 4,
        referenceType: "cycle_count_item",
        referenceId: "10",
      });
      expect(result).toMatchObject({
        success: true,
        transferredQty: 4,
        newExpectedQty: 6,
        newVarianceQty: 0,
        autoResolved: true,
        partnerItemId: 11,
        partnerAutoResolved: true,
      });
      expect(items.get(10)?.status).toBe("resolved");
      expect(items.get(11)?.status).toBe("resolved");
    });

    it("executes FIFO-lot-preserving transfers in bulkApprove before residual variance reconciliation", async () => {
      const items = new Map<number, any>([
        [
          20,
          {
            id: 20,
            cycleCountId: 77,
            warehouseLocationId: 5,
            productVariantId: 202,
            expectedSku: "SKU-B",
            expectedQty: 10,
            countedSku: "SKU-B",
            countedQty: 5,
            varianceQty: -5,
            varianceType: "quantity_under",
            status: "variance",
          },
        ],
        [
          21,
          {
            id: 21,
            cycleCountId: 77,
            warehouseLocationId: 6,
            productVariantId: 202,
            expectedSku: "SKU-B",
            expectedQty: 0,
            countedSku: "SKU-B",
            countedQty: 5,
            varianceQty: 5,
            varianceType: "quantity_over",
            status: "variance",
          },
        ],
      ]);

      const mockStorage: any = {
        getCycleCountById: vi.fn(async () => ({ id: 77, status: "in_progress", warehouseId: 1 })),
        getCycleCountItemById: vi.fn(async (id: number) => items.get(id) ?? null),
        getCycleCountItems: vi.fn(async () => Array.from(items.values())),
        getWarehouseLocationById: vi.fn(async (id: number) =>
          id === 5 ? { id: 5, code: "A-01" } : { id: 6, code: "B-02" },
        ),
        updateCycleCountItem: vi.fn(async (id: number, patch: any) => {
          const cur = items.get(id);
          if (cur) items.set(id, { ...cur, ...patch });
        }),
        updateCycleCount: vi.fn(async () => undefined),
      };

      const callOrder: string[] = [];
      const mockDb: any = {
        execute: vi.fn(async (query: any) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          if (sql.includes("FROM inventory.inventory_levels")) {
            if (params.includes(5)) {
              return { rows: [{ variant_qty: 10, reserved_qty: 2 }] };
            }
            return { rows: [{ variant_qty: 0, reserved_qty: 0 }] };
          }
          if (sql.includes("FROM warehouse.warehouse_locations")) {
            return {
              rows: [
                { id: 5, code: "A-01" },
                { id: 6, code: "B-02" },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const mockInventoryUseCases: any = {
        transfer: vi.fn(async (params: any) => {
          callOrder.push(`transfer:${params.fromLocationId}->${params.toLocationId}:${params.qty}`);
          return { reservedMoved: 0, orderItemsRepointed: 0, transferReceiptId: 777 };
        }),
      };

      const mockChannelSync: any = {
        queueSyncAfterInventoryChange: vi.fn(async () => undefined),
      };

      const cc = new CycleCountUseCases(
        mockDb,
        mockInventoryUseCases,
        mockChannelSync,
        {} as any,
        mockStorage,
        {} as any,
      );
      vi.spyOn(cc as any, "approveItemCore").mockImplementation(async (item: any) => {
        callOrder.push(`reconcile:${item.id}`);
        items.set(item.id, { ...item, status: "approved" });
        return { adjustment: null, negativeGuarded: false };
      });
      vi.spyOn(cc as any, "refreshBinStats").mockResolvedValue(undefined);

      const res = await cc.bulkApprove(77, {
        itemIds: [20, 21],
        reasonCode: "MISPLACED",
        approvedBy: "manager-1",
      });

      expect(res.transfersMade).toBe(1);
      expect(res.approved).toBe(2);
      expect(callOrder).toEqual(["transfer:5->6:5", "reconcile:20", "reconcile:21"]);
      expect(mockInventoryUseCases.transfer).toHaveBeenCalledWith(
        expect.objectContaining({
          cycleCountId: 77,
          productVariantId: 202,
          fromLocationId: 5,
          toLocationId: 6,
          qty: 5,
          commandKey: "cc-bulk-transfer:77:pv:202:from:5:to:6:qty:5",
        }),
      );
    });
  });

  describe("Spot Count & Build Execution Freeze Parity", () => {
    it("rejects spot-count exception creation when source bin is already frozen by another cycle count", async () => {
      const tx: any = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => {
          let tableRef: any = null;
          return {
            from: vi.fn((tbl: any) => {
              tableRef = tbl;
              return {
                where: vi.fn(() => ({
                  limit: vi.fn(async () => {
                    const name = tableRef?.[Symbol.for("drizzle:Name")] ?? "";
                    if (name === "replen_tasks") {
                      return [
                        {
                          id: 12,
                          status: "in_progress",
                          revision: 1,
                          sourceProductVariantId: 50,
                          fromLocationId: 9,
                          warehouseId: 1,
                        },
                      ];
                    }
                    if (name === "product_variants") {
                      return [{ id: 50, productId: 10, sku: "SKU-CASE" }];
                    }
                    if (name === "warehouse_locations") {
                      return [{ id: 9, code: "R-01", cycleCountFreezeId: 999 }];
                    }
                    return [];
                  }),
                })),
              };
            }),
          };
        }),
      };

      const database: any = {
        transaction: async (fn: any) => fn(tx),
      };

      await expect(
        reportReplenishmentException(
          database,
          12,
          {
            commandId: "00000000-0000-4000-8000-000000000012",
            expectedRevision: 1,
            expectedStatus: "in_progress",
            reason: "empty",
          },
          "picker-1",
          () => fixedNow,
        ),
      ).rejects.toMatchObject({ code: "LOCATION_FROZEN", statusCode: 409 });
    });

    it("freezes source bin and sets startedAt when creating a spot cycle count from replenishment exception", async () => {
      vi.mocked(freezeWarehouseLocationsChunkForCycleCountInWarehouse).mockClear();
      let insertedCountValues: any = null;
      const tx: any = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => {
          let tableRef: any = null;
          return {
            from: vi.fn((tbl: any) => {
              tableRef = tbl;
              return {
                where: vi.fn(() => ({
                  limit: vi.fn(async () => {
                    const name = tableRef?.[Symbol.for("drizzle:Name")] ?? "";
                    if (name === "replen_tasks") {
                      return [
                        {
                          id: 12,
                          status: "in_progress",
                          revision: 1,
                          sourceProductVariantId: 50,
                          fromLocationId: 9,
                          toLocationId: 15,
                          warehouseId: 1,
                        },
                      ];
                    }
                    if (name === "product_variants") {
                      return [{ id: 50, productId: 10, sku: "SKU-CASE" }];
                    }
                    if (name === "warehouse_locations") {
                      return [{ id: 9, code: "R-01", cycleCountFreezeId: null }];
                    }
                    if (name === "inventory_levels") {
                      return [{ id: 1, variantQty: 3 }];
                    }
                    return [];
                  }),
                })),
              };
            }),
          };
        }),
        insert: vi.fn((tbl: any) => ({
          values: vi.fn((vals: any) => {
            const name = tbl?.[Symbol.for("drizzle:Name")] ?? "";
            if (name === "cycle_counts") {
              insertedCountValues = vals;
              return { returning: vi.fn(async () => [{ id: 321, ...vals }]) };
            }
            return Promise.resolve();
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: 12 }]),
            })),
          })),
        })),
      };

      const database: any = {
        transaction: async (fn: any) => fn(tx),
      };

      const res = await reportReplenishmentException(
        database,
        12,
        {
          commandId: "00000000-0000-4000-8000-000000000013",
          expectedRevision: 1,
          expectedStatus: "in_progress",
          reason: "empty",
        },
        "picker-1",
        () => fixedNow,
      );

      expect(res).toEqual({
        taskId: 12,
        cycleCountId: 321,
        status: "blocked",
        exceptionReason: "empty",
      });
      expect(insertedCountValues?.startedAt).toEqual(fixedNow);
      expect(freezeWarehouseLocationsChunkForCycleCountInWarehouse).toHaveBeenCalledWith(
        tx,
        321,
        [9],
      );
    });

    it("rejects BuildExecutionRepository frozen location check with BUILD_LOCATION_FROZEN", async () => {
      const repo = new BuildExecutionRepository({} as any, {} as any);
      const tx: any = {
        execute: vi.fn(async () => ({
          rows: [{ id: 14, code: "BENCH-01", cycle_count_freeze_id: 77 }],
        })),
      };

      await expect(
        (repo as any).assertLocationsNotFrozen(tx, [14], 501),
      ).rejects.toMatchObject({ code: "BUILD_LOCATION_FROZEN" });
    });

    it("rejects canonical claim transformation execution when an operation location is frozen", async () => {
      const repo = new PostgresCanonicalClaimInventoryRepository();
      const client: any = {
        query: vi.fn(async (sqlText: string) => {
          if (sqlText.includes("FROM warehouse.warehouse_locations")) {
            return { rows: [{ id: 14, cycle_count_freeze_id: 77 }] };
          }
          return { rows: [] };
        }),
      };

      await expect(
        repo.executeBuildOperation({
          client,
          claimId: BigInt(1),
          orderId: 100,
          claimOperationId: BigInt(10),
          operationKey: "claim:1:op:10",
          outputLocationId: 14,
          destinationVariantId: 200,
          outputQty: BigInt(1),
          committedOutputQty: BigInt(1),
          actor: "asm-1",
          occurredAt: fixedNow,
          resources: [
            {
              claimResourceId: BigInt(5),
              inventoryLevelId: 3,
              warehouseLocationId: 14,
              sourceVariantId: 201,
              consumeQty: BigInt(1),
              lotAllocations: [
                {
                  claimLotAllocationId: BigInt(8),
                  inventoryLotId: 99,
                  consumeQty: BigInt(1),
                  unitCostMills: BigInt(1000),
                  poUnitCostMills: BigInt(1000),
                  packagingUnitCostMills: BigInt(0),
                  landedUnitCostMills: BigInt(0),
                },
              ],
            },
          ],
        } as any),
      ).rejects.toMatchObject({ code: "CLAIM_OPERATION_LOCATION_FROZEN" });
    });
  });

  describe("InterwarehouseTransferService.cancel()", () => {
    it("returns full in-transit stock to sourceLocationId via stage='cancel' and closes transfer as 'cancelled'", async () => {
      vi.mocked(closeInterwarehouseTransitLocationInWarehouse).mockClear();
      const locked = {
        id: 41,
        status: "in_transit",
        source_warehouse_id: 2,
        destination_warehouse_id: 1,
        source_location_id: 9,
        destination_location_id: 10,
        transit_location_id: 900,
        revision: 1,
        product_variant_id: 174,
        requested_qty: 50,
        dispatched_qty: 50,
        received_qty: 0,
        damaged_qty: 0,
        lost_qty: 0,
        cancelled_qty: 0,
      };

      const execute = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [locked] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 705 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 705,
              transfer_id: 41,
              event_type: "cancelled",
              effects_completed_at: null,
              product_variant_id: 174,
              source_location_id: 9,
              destination_location_id: 10,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 705 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 41,
              status: "cancelled",
              source_warehouse_id: 2,
              destination_warehouse_id: 1,
              source_location_id: 9,
              destination_location_id: 10,
              transit_location_id: 900,
              notes: "Restock Leon",
              exception_notes: "Truck turned back",
              created_by: "operator",
              dispatched_by: "operator",
              created_at: fixedNow,
              dispatched_at: fixedNow,
              completed_at: fixedNow,
              updated_at: fixedNow,
              revision: 2,
              source_warehouse_code: "RTE-19",
              source_warehouse_name: "Route 19",
              destination_warehouse_code: "LEON",
              destination_warehouse_name: "Leonberg",
              source_location_code: "FLOOR-01",
              destination_location_code: "FLOOR-03",
              product_variant_id: 174,
              requested_qty: 50,
              dispatched_qty: 0,
              received_qty: 0,
              damaged_qty: 0,
              lost_qty: 0,
              cancelled_qty: 50,
              sku: "SHLZ-SEMI-OVR-C2000",
              product_name: "Case of 2000",
            },
          ],
        });

      const tx = { execute };
      const database = {
        execute,
        transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
      };
      const transfer = vi.fn(async () => ({
        reservedMoved: 0,
        orderItemsRepointed: 0,
        transferReceiptId: 888,
      }));
      const inventory = { withTx: vi.fn(() => ({ transfer })) };
      const effects = { deliver: vi.fn(async () => undefined) };
      const service = new InterwarehouseTransferService(
        database as never,
        inventory as never,
        effects,
        () => fixedNow,
      );

      const summary = await service.cancel(
        41,
        { commandKey: "inventory:cancel:41:1", reason: "Truck turned back" },
        "supervisor-1",
      );

      expect(transfer).toHaveBeenCalledWith(
        expect.objectContaining({
          commandKey: "inventory:cancel:41:1:cancel_return",
          productVariantId: 174,
          fromLocationId: 900,
          toLocationId: 9,
          qty: 50,
          interwarehouseTransfer: { transferId: 41, stage: "cancel" },
        }),
      );
      expect(closeInterwarehouseTransitLocationInWarehouse).toHaveBeenCalledWith(tx, {
        transitLocationId: 900,
        occurredAt: fixedNow,
      });
      expect(effects.deliver).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 705, transferId: 41, eventType: "cancelled" }),
      );
      expect(summary).toMatchObject({
        status: "cancelled",
        inTransitQuantity: 0,
        dispatchedQuantity: 0,
      });
    });

    it("returns remaining unreceived stock after partial receipt and closes transfer as 'closed_with_variance'", async () => {
      const locked = {
        id: 42,
        status: "partially_received",
        source_warehouse_id: 2,
        destination_warehouse_id: 1,
        source_location_id: 9,
        destination_location_id: 10,
        transit_location_id: 901,
        revision: 2,
        product_variant_id: 174,
        requested_qty: 50,
        dispatched_qty: 50,
        received_qty: 30,
        damaged_qty: 0,
        lost_qty: 0,
        cancelled_qty: 0,
      };

      const execute = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [locked] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 706 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 706,
              transfer_id: 42,
              event_type: "cancelled",
              effects_completed_at: null,
              product_variant_id: 174,
              source_location_id: 9,
              destination_location_id: 10,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 706 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 42,
              status: "closed_with_variance",
              source_warehouse_id: 2,
              destination_warehouse_id: 1,
              source_location_id: 9,
              destination_location_id: 10,
              transit_location_id: 901,
              notes: "Split load",
              exception_notes: "Second pallet recalled",
              created_by: "operator",
              dispatched_by: "operator",
              created_at: fixedNow,
              dispatched_at: fixedNow,
              completed_at: fixedNow,
              updated_at: fixedNow,
              revision: 3,
              source_warehouse_code: "RTE-19",
              source_warehouse_name: "Route 19",
              destination_warehouse_code: "LEON",
              destination_warehouse_name: "Leonberg",
              source_location_code: "FLOOR-01",
              destination_location_code: "FLOOR-03",
              product_variant_id: 174,
              requested_qty: 50,
              dispatched_qty: 30,
              received_qty: 30,
              damaged_qty: 0,
              lost_qty: 0,
              cancelled_qty: 20,
              sku: "SHLZ-SEMI-OVR-C2000",
              product_name: "Case of 2000",
            },
          ],
        });

      const tx = { execute };
      const database = {
        execute,
        transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)),
      };
      const transfer = vi.fn(async () => ({
        reservedMoved: 0,
        orderItemsRepointed: 0,
        transferReceiptId: 889,
      }));
      const inventory = { withTx: vi.fn(() => ({ transfer })) };
      const effects = { deliver: vi.fn(async () => undefined) };
      const service = new InterwarehouseTransferService(
        database as never,
        inventory as never,
        effects,
        () => fixedNow,
      );

      const summary = await service.cancel(
        42,
        { commandKey: "inventory:cancel:42:1", reason: "Second pallet recalled" },
        "supervisor-1",
      );

      expect(transfer).toHaveBeenCalledWith(
        expect.objectContaining({
          fromLocationId: 901,
          toLocationId: 9,
          qty: 20,
          interwarehouseTransfer: { transferId: 42, stage: "cancel" },
        }),
      );
      const lineUpdate = execute.mock.calls
        .map(([q]) => new PgDialect().sqlToQuery(q))
        .find(({ sql }) => sql.includes("UPDATE inventory.interwarehouse_transfer_lines"));
      expect(lineUpdate?.params).toEqual([30, 20, 42]);
      expect(summary).toMatchObject({
        status: "closed_with_variance",
        receivedQuantity: 30,
        dispatchedQuantity: 30,
        inTransitQuantity: 0,
      });
    });
  });
});
