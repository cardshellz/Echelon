import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POSTGRES_TEST_FILES } from "../../../../../scripts/ci/postgres-test-manifest";
import { createReservationService } from "../../../channels/reservation.service";
import { InventoryUseCases } from "../../../inventory/application/inventory.use-cases";
import {
  SHORT_CLAIM_CANDIDATE_WINDOW,
  SHORT_CLAIM_REFRESH_LIMIT,
  getShortClaimRefreshDiagnostics,
  refreshShortClaims,
  resetShortClaimRefreshStateForTests,
} from "../../../oms/oms-flow-reconciliation.service";

function createLedgerBackedInventoryUseCases(initialVariantQty = 20) {
  const level = {
    id: 1,
    productVariantId: 10,
    warehouseLocationId: 20,
    variantQty: initialVariantQty,
    reservedQty: 0,
    pickedQty: 0,
  };
  const ledgerRows: Array<{
    id: number;
    productVariantId: number;
    fromLocationId?: number;
    transactionType: string;
    variantQtyDelta: number;
    reservedQtyDelta: number;
    orderId: number;
    orderItemId: number;
    referenceType: string;
    referenceId: string;
    notes?: string;
    voidedAt?: Date | null;
  }> = [];

  const mockStorage: any = {
    upsertInventoryLevel: vi.fn(async () => ({ ...level })),
    lockInventoryLevel: vi.fn(async () => ({ ...level })),
    getInventoryLevelByVariantAndLocation: vi.fn(async () => ({ ...level })),
    adjustInventoryLevel: vi.fn(async (_id: number, delta: Record<string, number>) => {
      if (typeof delta.reservedQty === "number") {
        level.reservedQty += delta.reservedQty;
      }
      if (typeof delta.variantQty === "number") {
        level.variantQty += delta.variantQty;
      }
    }),
    createInventoryTransaction: vi.fn(async (txn: any) => {
      const record = {
        id: ledgerRows.length + 1,
        ...txn,
        voidedAt: null,
      };
      ledgerRows.push(record);
      return record;
    }),
  };

  const executeFn = vi.fn(async () => ({
    rows: ledgerRows
      .filter((r) => !r.voidedAt && (r.transactionType === "reserve" || r.transactionType === "unreserve"))
      .map((r) => ({
        id: r.id,
        transactionType: r.transactionType,
        reservedQtyDelta: r.reservedQtyDelta,
      })),
  }));

  const mockDb: any = {
    transaction: async (fn: any) => fn({ execute: executeFn }),
  };

  const uc = new InventoryUseCases(mockDb, mockStorage);
  return { uc, level, ledgerRows, mockStorage };
}

describe("PLAN-1 — Allocation, Reservation Replacement, Short-Claim Fairness & CI Lineage Safeguards", () => {
  beforeEach(() => {
    resetShortClaimRefreshStateForTests();
  });

  describe("A-01: Legacy reservation replacement after release", () => {
    it("re-reserves full requested quantity after releaseReservation and preserves idempotent replay", async () => {
      const { uc, level, ledgerRows } = createLedgerBackedInventoryUseCases(20);

      // Step 1: Initial reserve of 3 units
      const firstReserve = await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 3,
        orderId: 42,
        orderItemId: 700,
      });
      expect(firstReserve).toBe(true);
      expect(level.reservedQty).toBe(3);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        transactionType: "reserve",
        reservedQtyDelta: 3,
        referenceType: "order",
        referenceId: "42",
      });

      // Step 2: Duplicate replay of 3 units is a no-op
      const replayInitial = await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 3,
        orderId: 42,
        orderItemId: 700,
      });
      expect(replayInitial).toBe(true);
      expect(level.reservedQty).toBe(3);
      expect(ledgerRows).toHaveLength(1);

      // Step 3: Release those 3 units (e.g. reconcileOrderDemand release step)
      await uc.releaseReservation({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 3,
        orderId: 42,
        orderItemId: 700,
        reason: "order edited",
      });
      expect(level.reservedQty).toBe(0);
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows[1]).toMatchObject({
        transactionType: "unreserve",
        reservedQtyDelta: -3,
      });

      // Step 4: Re-reserve 5 units for the same (orderId, orderItemId)
      const replacementReserve = await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 5,
        orderId: 42,
        orderItemId: 700,
      });
      expect(replacementReserve).toBe(true);
      expect(level.reservedQty).toBe(5);
      expect(ledgerRows).toHaveLength(3);
      expect(ledgerRows[2]).toMatchObject({
        transactionType: "reserve",
        reservedQtyDelta: 5,
        referenceType: "order",
        referenceId: "42:rev:2",
      });

      // Net ledger delta equals level.reservedQty (5)
      const netLedgerReserved = ledgerRows.reduce((sum, r) => sum + r.reservedQtyDelta, 0);
      expect(netLedgerReserved).toBe(5);

      // Step 5: Subsequent replay of 5 units is idempotent (no third reserve row)
      const replayReplacement = await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 5,
        orderId: 42,
        orderItemId: 700,
      });
      expect(replayReplacement).toBe(true);
      expect(level.reservedQty).toBe(5);
      expect(ledgerRows).toHaveLength(3);
    });
  });

  describe("A-02: Partial-reservation restock top-up and autoReserveOnSync open coverage check", () => {
    it("tops up only the missing delta when an order line was partially reserved and later restocked", async () => {
      const { uc, level, ledgerRows } = createLedgerBackedInventoryUseCases(10);

      // Partial initial reserve of 2 units
      await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 2,
        orderId: 55,
        orderItemId: 800,
      });
      expect(level.reservedQty).toBe(2);

      // Later retry requests total 5 units -> reserves only the missing +3 delta
      const topUp = await uc.reserveForOrder({
        productVariantId: 10,
        warehouseLocationId: 20,
        qty: 5,
        orderId: 55,
        orderItemId: 800,
      });
      expect(topUp).toBe(true);
      expect(level.reservedQty).toBe(5);
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows[1]).toMatchObject({
        transactionType: "reserve",
        reservedQtyDelta: 3,
        referenceId: "55:rev:2",
      });
    });

    it("autoReserveOnSync re-runs reserveOrder when prior reserve was partially reserved or later unreserved, and skips when fully covered", async () => {
      const makeAutoSyncDb = (txRows: any[], buildDemandRows: any[] = []) => {
        const selectQueue = [
          [{ id: 42, shopifyOrderId: "gid://shopify/Order/42", warehouseStatus: "ready" }],
          [{ id: 700, orderId: 42, sku: "SKU-1", quantity: 5, catalogProductId: 3, productId: 9 }],
          [{ id: 9, sku: "SKU-1", productId: 3, unitsPerVariant: 1 }],
          txRows,
        ];
        const makeChain = () => {
          const rows = selectQueue.shift() ?? [];
          const chain: any = {
            from: () => chain,
            where: () => chain,
            limit: () => chain,
            then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
          };
          return chain;
        };
        return {
          select: vi.fn(() => makeChain()),
          execute: vi.fn(async () => ({ rows: buildDemandRows })),
        } as any;
      };

      // Case 1: Reserve of 5 was later unreserved (-5) -> net open = 0 < 5 -> must call reserveOrder
      const dbUnreserved = makeAutoSyncDb([
        { orderItemId: 700, productVariantId: 9, transactionType: "reserve", reservedQtyDelta: 5 },
        { orderItemId: 700, productVariantId: 9, transactionType: "unreserve", reservedQtyDelta: -5 },
      ]);
      const svc1 = createReservationService(dbUnreserved, {}, { queueSyncAfterInventoryChange: vi.fn() }, {});
      const spy1 = vi.spyOn(svc1, "reserveOrder").mockResolvedValue({
        orderId: 42,
        reserved: 1,
        promised: 0,
        failed: [],
        totalBaseUnits: 5,
        totalPromisedBaseUnits: 0,
      });
      await svc1.autoReserveOnSync("gid://shopify/Order/42", "sync-actor");
      expect(spy1).toHaveBeenCalledWith(42, "sync-actor", dbUnreserved);

      // Case 2: Partial reserve of 2 with no build promise -> net open = 2 < 5 -> must call reserveOrder
      const dbPartial = makeAutoSyncDb([
        { orderItemId: 700, productVariantId: 9, transactionType: "reserve", reservedQtyDelta: 2 },
      ]);
      const svc2 = createReservationService(dbPartial, {}, { queueSyncAfterInventoryChange: vi.fn() }, {});
      const spy2 = vi.spyOn(svc2, "reserveOrder").mockResolvedValue({
        orderId: 42,
        reserved: 1,
        promised: 0,
        failed: [],
        totalBaseUnits: 5,
        totalPromisedBaseUnits: 0,
      });
      await svc2.autoReserveOnSync("gid://shopify/Order/42", "sync-actor");
      expect(spy2).toHaveBeenCalledWith(42, "sync-actor", dbPartial);

      // Case 3: Partial reserve of 2 + active build promise of 3 -> covered (2 + 3 >= 5) -> skips reserveOrder
      const dbCovered = makeAutoSyncDb(
        [{ orderItemId: 700, productVariantId: 9, transactionType: "reserve", reservedQtyDelta: 2 }],
        [{ status: "awaiting_build", promised_qty: 3, short_qty: 3 }],
      );
      const svc3 = createReservationService(dbCovered, {}, { queueSyncAfterInventoryChange: vi.fn() }, {});
      const spy3 = vi.spyOn(svc3, "reserveOrder");
      await expect(svc3.autoReserveOnSync("gid://shopify/Order/42", "sync-actor")).resolves.toBeNull();
      expect(spy3).not.toHaveBeenCalled();
    });
  });

  describe("A-03: Persisted variant identity in releaseOrderReservation", () => {
    it("releases open reservations using persisted item.productId even after a catalog SKU rename", async () => {
      const wherePredicates: any[] = [];
      const selectQueue = [
        // orderItems row has old SKU on the order line, but persisted catalogProductId + productId (variant id 99)
        [{ id: 700, orderId: 42, sku: "OLD-SKU", quantity: 4, catalogProductId: 12, productId: 99 }],
        // productVariants row now has NEW-SKU
        [{ id: 99, sku: "NEW-SKU", productId: 12, unitsPerVariant: 1 }],
        // inventoryLevels row for variant 99
        [{ id: 1, warehouseLocationId: 10, reservedQty: 4, productVariantId: 99 }],
      ];
      const makeChain = () => {
        const rows = selectQueue.shift() ?? [];
        const chain: any = {
          from: () => chain,
          innerJoin: () => chain,
          where: (pred: any) => {
            wherePredicates.push(pred);
            return chain;
          },
          orderBy: () => chain,
          limit: () => chain,
          then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
        };
        return chain;
      };
      const db: any = {
        select: vi.fn(() => makeChain()),
        execute: vi.fn(async () => ({
          rows: [{ delta_sum: 4, legacy_reserves: 0, picked_units: 0, unreserved_units: 0 }],
        })),
      };
      const releaseReservation = vi.fn(async () => undefined);
      const svc = createReservationService(
        db,
        { releaseReservation },
        { queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined) },
        {},
      );

      const res = await svc.releaseOrderReservation(42, "cancelled_after_sku_rename");
      expect(res.released).toBe(1);
      expect(res.failed).toHaveLength(0);
      expect(releaseReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          productVariantId: 99,
          warehouseLocationId: 10,
          qty: 4,
          orderId: 42,
          orderItemId: 700,
        }),
        db,
      );
    });
  });

  describe("A-05: Short-claim sweeper fair rotation and decline telemetry", () => {
    it("prevents 25 persistently declining oldest orders from starving the 26th improvable order on the next sweep", async () => {
      // Orders 1..25 decline persistently (e.g. only case-break supply exists); Order 26 can be refreshed
      const candidateOrderIds = Array.from({ length: 26 }, (_, i) => i + 1);
      const mockDb = {
        execute: vi.fn(async () => ({
          rows: candidateOrderIds.map((order_id) => ({ order_id })),
        })),
      };
      const refreshShortClaimSupply = vi.fn(async (orderId: number) => {
        if (orderId === 26) {
          return { outcome: "refreshed", claimId: "claim-26", idempotentReplay: false };
        }
        return {
          outcome: "declined",
          code: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT",
          message: "Only case-break supply available",
        };
      });
      const deps: any = {
        reservation: {
          reserveOrder: vi.fn(),
          releaseOrderReservation: vi.fn(),
          refreshShortClaimSupply,
        },
        fulfillmentAuthority: {},
      };

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        // Sweep 1: processes oldest 1..25, all 25 decline
        const sweep1 = await refreshShortClaims(mockDb, deps);
        expect(sweep1).toEqual({ refreshed: 0, declined: 25, failed: 0 });

        const diagAfterSweep1 = getShortClaimRefreshDiagnostics();
        expect(diagAfterSweep1.declinedOrderCount).toBe(25);
        expect(diagAfterSweep1.declineCodeCounts).toEqual({
          CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT: 25,
        });

        // Sweep 2: Order 26 (non-declined, seq = 0) is rotated to the front and refreshed!
        const sweep2 = await refreshShortClaims(mockDb, deps);
        expect(sweep2).toEqual({ refreshed: 1, declined: 24, failed: 0 });
        expect(refreshShortClaimSupply).toHaveBeenCalledWith(26);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("excludes receiving, staging, and quarantine bins in the short-claim candidate SQL query", () => {
      const source = readFileSync(
        resolve(process.cwd(), "server/modules/oms/oms-flow-reconciliation.service.ts"),
        "utf8",
      );
      expect(SHORT_CLAIM_REFRESH_LIMIT).toBe(25);
      expect(SHORT_CLAIM_CANDIDATE_WINDOW).toBeGreaterThanOrEqual(250);
      expect(source).toContain("COALESCE(wl.location_type, 'pick') NOT IN ('receiving', 'staging', 'quarantine')");
      expect(source).toContain("wl.warehouse_id IS NOT NULL");
    });
  });

  describe("A-07: Claim lineage integration suite CI registration and local disposable DB guard", () => {
    it("registers inventory-availability-claim-lineage.integration.test.ts in POSTGRES_TEST_FILES and enforces local disposable host check", () => {
      const suitePath =
        "server/modules/inventory-planning/__tests__/integration/inventory-availability-claim-lineage.integration.test.ts";
      expect(POSTGRES_TEST_FILES).toContain(suitePath);

      const source = readFileSync(resolve(process.cwd(), suitePath), "utf8");
      expect(source).toContain("assertLocalDisposableDatabaseUrl(TEST_DB_URL)");
      expect(source).toContain("ssl: false");
      expect(source).not.toContain("rejectUnauthorized: false");
    });
  });
});
