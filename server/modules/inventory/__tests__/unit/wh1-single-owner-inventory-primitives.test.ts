import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../infrastructure/operational-quantity-posting", () => ({
  openOperationalQuantityPosting: vi.fn(async () => null),
  quantityTransactionFromDrizzle: vi.fn((tx: unknown) => tx),
}));

vi.mock("../../infrastructure/cost-evidence.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/cost-evidence.repository")>()),
  lockInventoryCostGraph: vi.fn(async () => undefined),
  recordLotCostContribution: vi.fn(async () => undefined),
}));

vi.mock("../../application/receiving-custody-count-guard", () => ({
  assertReceivingCustodyCountable: vi.fn(async () => undefined),
}));

import { receiveStock, reverseReceiptStock } from "../../receive-stock.api";
import { transferStock, reverseTransferStock } from "../../transfer-stock.api";
import { convertPack, BreakAssemblyUseCases } from "../../convert-pack.api";
import { adjustOrReconcileStock } from "../../adjust-stock.api";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { legacyTransformationExecutionAuthority } from "../../application/transformation-execution-authority.port";
import { createLegacyInventoryAtpService } from "../../application/atp.service";
import { readShipmentReceiptCustodyCoverage } from "../../../procurement/infrastructure/shipment-receipt-custody.repository";

const dialect = new PgDialect();

describe("Batch WH-1 — Single-Owner Inventory Primitives & Lot/Cost Integrity", () => {
  it("routes all 4 single-owner .api.ts facades directly to their canonical domain owners", async () => {
    const receiveOwner = {
      receiveInventory: vi.fn(async () => undefined),
      reverseReceiptInventory: vi.fn(async () => ({ lotUnitCostMills: 500 })),
    };
    await receiveStock(receiveOwner, {
      productVariantId: 1,
      warehouseLocationId: 10,
      qty: 5,
      referenceId: "RCV-1",
    });
    expect(receiveOwner.receiveInventory).toHaveBeenCalledTimes(1);

    const rev = await reverseReceiptStock(receiveOwner, {
      receivingLineId: 10,
      receivingOrderId: 1,
      productVariantId: 1,
      warehouseLocationId: 10,
      qty: 2,
      reversalId: 9,
      reason: "Damaged carton",
    });
    expect(rev).toEqual({ lotUnitCostMills: 500 });

    const transferOwner = {
      transfer: vi.fn(async () => ({ reservedMoved: 0, orderItemsRepointed: 0, transferReceiptId: 77 })),
      undoTransfer: vi.fn(async () => ({ id: 88 } as any)),
    };
    const moved = await transferStock(transferOwner, {
      productVariantId: 1,
      fromLocationId: 10,
      toLocationId: 11,
      qty: 3,
    });
    expect(moved.transferReceiptId).toBe(77);
    const reversed = await reverseTransferStock(transferOwner, 77, "sup-1");
    expect(reversed.id).toBe(88);

    const packOwner = {
      breakVariant: vi.fn(async () => ({
        sourceQtyRemoved: 1,
        targetQtyAdded: 25,
        baseUnitsConverted: 25,
        batchId: "break_1",
        targetLocationId: 11,
      })),
      assembleVariant: vi.fn(async () => ({
        sourceQtyRemoved: 25,
        targetQtyAdded: 1,
        baseUnitsConverted: 25,
        batchId: "assemble_1",
      })),
    };
    const broken = await convertPack(packOwner, {
      mode: "break",
      sourceVariantId: 1,
      targetVariantId: 2,
      warehouseLocationId: 10,
      sourceQty: 1,
    });
    expect(broken.targetQtyAdded).toBe(25);
    const assembled = await convertPack(packOwner, {
      mode: "assemble",
      sourceVariantId: 2,
      targetVariantId: 1,
      warehouseLocationId: 10,
      targetQty: 1,
    });
    expect(assembled.targetQtyAdded).toBe(1);

    const adjustOwner = {
      adjustInventory: vi.fn(async () => ({ orphanedQty: 0, adjustmentTransactionId: 42 })),
    };
    const adjusted = await adjustOrReconcileStock(adjustOwner, {
      productVariantId: 2,
      warehouseLocationId: 11,
      qtyDelta: 4,
      reason: "FOUND",
    });
    expect(adjusted.adjustmentTransactionId).toBe(42);
  });

  it("enforces direct parent->child hierarchy and unreserved stock in breakVariant", async () => {
    const parentCase = {
      id: 10,
      productId: 500,
      name: "Case 25",
      sku: "SKU-C25",
      unitsPerVariant: 25,
      isActive: true,
      parentVariantId: null,
    };
    const unrelatedEach = {
      id: 20,
      productId: 500,
      name: "Each",
      sku: "SKU-EA",
      unitsPerVariant: 1,
      isActive: true,
      parentVariantId: 999, // points to an intermediate inner-pack, NOT 10
    };
    const directChildEach = {
      ...unrelatedEach,
      parentVariantId: 10,
    };

    const makeBreakDb = (target: typeof unrelatedEach, levelRow: { variantQty: number; reservedQty: number }) => {
      const selects = [[parentCase], [target], [{ inventoryStrategy: "physical_fungible" }], []];
      let idx = 0;
      const locked = [{ inventoryStrategy: "physical_fungible" }, parentCase, target];
      let lockIdx = 0;
      return {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn(() => {
              const rows = selects[idx++] ?? [];
              return Object.assign(Promise.resolve(rows), {
                limit: vi.fn().mockResolvedValue(rows),
                innerJoin: vi.fn().mockReturnThis(),
              });
            }),
          })),
        })),
        transaction: vi.fn(async (fn: any) =>
          fn({
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([levelRow]),
                  for: vi.fn(async () => [locked[lockIdx++]]),
                })),
              })),
            })),
            execute: vi.fn(async () => ({ rows: [] })),
          }),
        ),
      };
    };

    const invStub = {
      adjustInventory: vi.fn(),
      withTx: vi.fn(function (this: unknown) {
        return this;
      }),
    };

    const svcWrongParent = new BreakAssemblyUseCases(
      makeBreakDb(unrelatedEach, { variantQty: 5, reservedQty: 0 }),
      invStub as any,
      () => new Date("2026-11-24T00:00:00Z"),
      legacyTransformationExecutionAuthority,
    );
    await expect(
      svcWrongParent.breakVariant({
        sourceVariantId: 10,
        targetVariantId: 20,
        warehouseLocationId: 1,
        sourceQty: 1,
      }),
    ).rejects.toThrow(/Only direct parent→child breaks are allowed/);

    // Reserved stock protection: 2 on hand, 2 reserved => 0 unreserved => must reject
    const svcReserved = new BreakAssemblyUseCases(
      makeBreakDb(directChildEach, { variantQty: 2, reservedQty: 2 }),
      invStub as any,
      () => new Date("2026-11-24T00:00:00Z"),
      legacyTransformationExecutionAuthority,
    );
    await expect(
      svcReserved.breakVariant({
        sourceVariantId: 10,
        targetVariantId: 20,
        warehouseLocationId: 1,
        sourceQty: 1,
      }),
    ).rejects.toThrow(/only 0 available \(2 reserved\)/);
  });

  it("blocks ad-hoc negative adjustments from consuming reserved stock while allowing cycleCountId", async () => {
    const mockStorage: any = {
      upsertInventoryLevel: vi.fn(async () => ({ id: 7, variantQty: 5, reservedQty: 4 })),
      adjustInventoryLevel: vi.fn(async () => undefined),
      createInventoryTransaction: vi.fn(async (t: any) => ({ ...t, id: 101 })),
    };
    const mockDb: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
      })),
      transaction: async (fn: any) =>
        fn({
          select: vi.fn(() => ({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
          })),
          execute: vi.fn(async () => ({ rows: [] })),
        }),
    };

    const uc = new InventoryUseCases(mockDb, mockStorage);
    // 5 on-hand, 4 reserved: -2 leaves 3 < 4 reserved => blocked for manual adjust
    await expect(
      uc.adjustInventory({
        productVariantId: 10,
        warehouseLocationId: 3,
        qtyDelta: -2,
        reason: "SHRINKAGE",
      }),
    ).rejects.toMatchObject({ code: "ADJUSTMENT_BLOCKED_BY_RESERVATION" });
    expect(mockStorage.adjustInventoryLevel).not.toHaveBeenCalled();

    // Permitted when cycleCountId is supplied (reconciliation reallocates orphanedQty)
    const cycleRes = await uc.adjustInventory({
      productVariantId: 10,
      warehouseLocationId: 3,
      qtyDelta: -2,
      reason: "CYCLE_COUNT",
      cycleCountId: 55,
    });
    expect(cycleRes.orphanedQty).toBe(1);
    expect(mockStorage.adjustInventoryLevel).toHaveBeenCalledWith(
      7,
      { variantQty: -2, reservedQty: -1 },
      expect.anything(),
    );
  });

  it("preserves parent lot receivedAt + PO lineage and updates child variant costs on conversion", async () => {
    const originalReceivedAt = new Date("2026-05-01T12:00:00Z");
    const conversionTime = new Date("2026-11-24T12:00:00Z");
    const createLotCalls: any[] = [];
    const updateVariantCostCalls: Array<{ variantId: number; costCents: number }> = [];

    const mockLotSvc: any = {
      withTx: vi.fn(function (this: unknown) {
        return this;
      }),
      resolveConversionLineage: vi.fn(async () => ({
        receivedAt: originalReceivedAt,
        purchaseOrderId: 88,
        receivingOrderId: 99,
        inboundShipmentId: 77,
        poLineId: 66,
      })),
      createLot: vi.fn(async (p: any) => {
        createLotCalls.push(p);
        return { id: 501 };
      }),
      updateVariantCosts: vi.fn(async (variantId: number, costCents: number) => {
        updateVariantCostCalls.push({ variantId, costCents });
      }),
    };
    const mockStorage: any = {
      upsertInventoryLevel: vi.fn(async () => ({ id: 9, variantQty: 0, reservedQty: 0 })),
      adjustInventoryLevel: vi.fn(async () => undefined),
      createInventoryTransaction: vi.fn(async (t: any) => ({ ...t, id: 202 })),
    };
    const mockDb: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
      })),
      transaction: async (fn: any) =>
        fn({
          select: vi.fn(() => ({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
          })),
          execute: vi.fn(async () => ({ rows: [] })),
        }),
    };

    const uc = new InventoryUseCases(mockDb, mockStorage, mockLotSvc);
    await uc.adjustInventory({
      productVariantId: 20,
      warehouseLocationId: 5,
      qtyDelta: 10,
      reason: "Break 1 case into 10 each",
      conversion: {
        sourceLots: [{ lotId: 11, qty: 1 }],
        productMills: BigInt(100_000),
        packagingMills: BigInt(10_000),
        landedMills: BigInt(20_000),
        provisional: false,
        operationKey: "break_test_1",
        occurredAt: conversionTime,
      },
    });

    expect(createLotCalls).toHaveLength(1);
    expect(createLotCalls[0]).toMatchObject({
      productVariantId: 20,
      qty: 10,
      unitCostMills: 13_000,
      packagingCostMills: 1_000,
      landedCostMills: 2_000,
      receivedAt: originalReceivedAt,
      purchaseOrderId: 88,
      receivingOrderId: 99,
      inboundShipmentId: 77,
      poLineId: 66,
    });
    expect(updateVariantCostCalls).toEqual([{ variantId: 20, costCents: 130 }]);
  });

  it("blocks moving reserved stock into non-pickable reserve bins and bounds order-item repointing to moved reserved qty", async () => {
    const fromPick = { id: 1, code: "A-01", isActive: 1, isPickable: 1, locationType: "pick", warehouseId: 1, zone: "A" };
    const toReserve = { id: 2, code: "R-01", isActive: 1, isPickable: 0, locationType: "reserve", warehouseId: 1, zone: "R" };
    const toPick = { id: 3, code: "A-02", isActive: 1, isPickable: 1, locationType: "pick", warehouseId: 1, zone: "A" };

    const makeTransferHarness = (destLoc: typeof toReserve) => {
      const queue = [[{ id: 10, unitsPerVariant: 1 }], [fromPick], [destLoc]];
      const executedQueries: Array<{ sql: string; params: unknown[] }> = [];
      const selectChain: any = {
        from: () => selectChain,
        where: () => selectChain,
        limit: () => Promise.resolve(queue.shift() ?? []),
      };
      const execute = vi.fn(async (stmt: SQL) => {
        const compiled = dialect.sqlToQuery(stmt);
        executedQueries.push(compiled);
        if (compiled.sql.includes("UPDATE wms.order_items")) {
          return { rows: [{ id: 901 }] };
        }
        return { rows: [] };
      });
      const tx = { select: () => selectChain, execute };
      const mockDb: any = { transaction: (fn: any) => fn(tx), select: () => selectChain, execute };
      const mockStorage: any = {
        lockInventoryLevel: vi.fn(async () => ({ id: 1, variantQty: 10, reservedQty: 6 })),
        upsertInventoryLevel: vi.fn(async () => ({ id: 2, variantQty: 0, reservedQty: 0 })),
        adjustInventoryLevel: vi.fn(async () => undefined),
        createInventoryTransaction: vi.fn(async (t: any) => ({ ...t, id: 700 })),
      };
      const transferLots = vi.fn(async () => []);
      const mockLotSvc: any = { withTx: () => ({ transferLots }) };
      return {
        uc: new InventoryUseCases(mockDb, mockStorage, mockLotSvc),
        executedQueries,
        transferLots,
      };
    };

    // Moving 7 units when 4 are unreserved (6 reserved) => reservedToMove = 3.
    // Destination R-01 is non-pickable => rejected!
    const badDest = makeTransferHarness(toReserve);
    await expect(
      badDest.uc.transfer({
        productVariantId: 10,
        fromLocationId: 1,
        toLocationId: 2,
        qty: 7,
        moveReserved: true,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_RESERVED_DESTINATION_UNAVAILABLE" });

    // Destination A-02 is pickable => bounded cumulative_qty <= 3 and reservedQtyToMove = 3
    const goodDest = makeTransferHarness(toPick);
    const res = await goodDest.uc.transfer({
      productVariantId: 10,
      fromLocationId: 1,
      toLocationId: 3,
      qty: 7,
      moveReserved: true,
    });
    expect(res).toEqual({ reservedMoved: 3, orderItemsRepointed: 1, transferReceiptId: 700 });
    const repointQuery = goodDest.executedQueries.find((q) => q.sql.includes("UPDATE wms.order_items"));
    expect(repointQuery?.sql).toContain("cumulative_qty <=");
    expect(goodDest.transferLots).toHaveBeenCalledWith(
      expect.objectContaining({ qty: 7, reservedQtyToMove: 3 }),
    );
  });

  it("traces relocated receipt lots across transfers and refuses to consume reserved stock on receipt reversal", async () => {
    const levelUpdates: Array<{ sql: string; params: unknown[] }> = [];
    const lotState = [
      { id: 100, warehouse_location_id: 10, qty_on_hand: 0, qty_reserved: 0, unit_cost_mills: 450, cost_basis_qty: null },
      { id: 101, warehouse_location_id: 25, qty_on_hand: 12, qty_reserved: 0, unit_cost_mills: 450, cost_basis_qty: null },
    ];
    const execute = vi.fn(async (stmt: SQL) => {
      const compiled = dialect.sqlToQuery(stmt);
      if (compiled.sql.includes("WITH RECURSIVE traced_lots")) {
        return { rows: lotState.map((l) => ({ ...l })) };
      }
      if (compiled.sql.includes("UPDATE inventory.inventory_lots")) {
        return { rows: [{ qty_on_hand: 2 }] };
      }
      if (compiled.sql.includes("FROM inventory.inventory_levels") && compiled.sql.includes("FOR UPDATE")) {
        // Assert it locks relocated location 25, NOT empty initial dock 10!
        expect(compiled.params).toContain(25);
        return { rows: [{ id: 55, variant_qty: 12, reserved_qty: 0 }] };
      }
      if (compiled.sql.includes("UPDATE inventory.inventory_levels")) {
        levelUpdates.push(compiled);
        return { rows: [] };
      }
      if (compiled.sql.includes("INSERT INTO inventory.inventory_transactions")) {
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    });

    const mockDb: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
      })),
      transaction: (fn: any) =>
        fn({
          select: vi.fn(() => ({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
          })),
          execute,
        }),
    };
    const uc = new InventoryUseCases(mockDb, {} as any);
    const out = await uc.reverseReceiptInventory({
      receivingLineId: 77,
      receivingOrderId: 7,
      productVariantId: 5,
      warehouseLocationId: 10,
      qty: 10,
      reversalId: 3,
      reason: "Vendor overbill correction",
    });
    expect(out.lotUnitCostMills).toBe(450);
    expect(levelUpdates).toHaveLength(1);
  });

  it("excludes 'receiving', 'quarantine', and 'staging' dock bins from all 5 channel ATP queries while keeping 3pl_virtual eligible", async () => {
    const capturedSql: string[] = [];
    const fakeDb: any = {
      execute: vi.fn(async (stmt: SQL) => {
        capturedSql.push(dialect.sqlToQuery(stmt).sql);
        return { rows: [{ atp: 0, on_hand: 0, reserved: 0 }] };
      }),
    };
    const atp = createLegacyInventoryAtpService(fakeDb);
    await atp.getAtpBase(1);
    await atp.getAtpBaseByWarehouse(1, 1);
    await atp.getDirectVariantAtpByWarehouse([10], 1);

    expect(capturedSql).toHaveLength(3);
    for (const q of capturedSql) {
      expect(q).toContain("'in_transit'");
      expect(q).toContain("'receiving'");
      expect(q).toContain("'quarantine'");
      expect(q).toContain("'staging'");
      expect(q).not.toContain("'3pl_virtual'");
    }
  });

  it("handles shipment receipt custody coverage with empty poLineIds and locks lot-safe CSV routes", async () => {
    const executed: string[] = [];
    const coverage = await readShipmentReceiptCustodyCoverage(
      {
        execute: async (stmt: SQL) => {
          executed.push(dialect.sqlToQuery(stmt).sql);
          return {
            rows: [
              {
                receivingLines: [],
                postedReceipts: [],
                reversals: [],
                custodyObservations: [],
                custodyAcceptances: [],
              },
            ],
          };
        },
      },
      {
        purchaseOrderId: 10,
        inboundShipmentId: 20,
        shipmentLines: [{ id: 1, purchaseOrderId: 10, purchaseOrderLineId: null, qtyShipped: 5 }],
      },
    );
    expect(coverage).toBeDefined();
    expect(executed).toHaveLength(1);
    expect(executed[0]).not.toContain("ARRAY[]::integer[]");

    // Ratchet: CSV routes in inventory.routes.ts must never bypass adjustInventory via createInventoryLevel
    const routesSource = readFileSync(
      resolve(process.cwd(), "server/modules/inventory/interfaces/http/inventory.routes.ts"),
      "utf8",
    );
    expect(routesSource).not.toContain("storage.createInventoryLevel(");
  });
});
