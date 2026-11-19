import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createReservationService } from "../../../channels/reservation.service";
import { InventoryAvailabilityClaimService } from "../../application/inventory-availability-claim.service";
import * as claimExecutionApi from "../../claim-execution.api";
import * as cutoverRetiredWorkApi from "../../cutover-retired-work.api";
import * as dropshipDestinationHealthApi from "../../dropship-stock-destination-health.api";
import * as inventoryPlanningIndex from "../../index";
import * as legacyAdminControlApi from "../../legacy-admin-control.api";
import * as publicationGlobalControlApi from "../../publication-global-control.api";
import * as publicationTargetHoldApi from "../../publication-target-hold.api";
import * as quantityPublicationAdmissionApi from "../../quantity-publication-admission.api";
import type { ReservationServiceContract } from "../../reservation-authority.api";
import * as runtimeAvailabilityApi from "../../runtime-availability.api";
import { PostgresInventoryAvailabilityRuntimeClaimExecutor } from "../../infrastructure/inventory-availability-runtime-claim.repository";

const MODULES_ROOT = path.resolve(process.cwd(), "server/modules");

function collectPeerModuleSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "inventory-planning") continue;
      collectPeerModuleSourceFiles(fullPath, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(fullPath);
    }
  }
  return acc;
}

describe("Priority 6 Batch PLAN-2: Inventory-Planning API Boundaries, Reservation Authority & Concurrency Safeguards", () => {
  describe("CI-03: Peer modules never import from inventory-planning/infrastructure/*", () => {
    it("enforces zero direct imports into inventory-planning/infrastructure across all peer server/modules/*", () => {
      const peerFiles = collectPeerModuleSourceFiles(MODULES_ROOT);
      expect(peerFiles.length).toBeGreaterThan(100);

      const violations: string[] = [];
      const infraImportPattern = /from\s+["'][^"']*inventory-planning\/infrastructure\/[^"']+["']|import\(\s*["'][^"']*inventory-planning\/infrastructure\/[^"']+["']\s*\)/g;

      for (const file of peerFiles) {
        const content = fs.readFileSync(file, "utf8");
        const matches = content.match(infraImportPattern);
        if (matches && matches.length > 0) {
          const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
          violations.push(`${rel}: ${matches.join(", ")}`);
        }
      }

      expect(violations).toEqual([]);
    });

    it("exposes complete internal API facades for inventory-planning", () => {
      expect(typeof legacyAdminControlApi.createInventoryLegacyAdminControlService).toBe("function");
      expect(typeof legacyAdminControlApi.sendInventoryLegacyAdminControlError).toBe("function");
      expect(legacyAdminControlApi.INVENTORY_LEGACY_ADMIN_CONTROLS).toBeDefined();

      expect(typeof publicationGlobalControlApi.InventoryPublicationGlobalControlService).toBe("function");
      expect(typeof publicationGlobalControlApi.PostgresInventoryPublicationGlobalControlStore).toBe("function");
      expect(typeof publicationGlobalControlApi.applyInventoryPublicationGlobalControlInsideTransaction).toBe("function");

      expect(typeof cutoverRetiredWorkApi.assertReceiptNotRetired).toBe("function");
      expect(typeof cutoverRetiredWorkApi.assertShipmentNotRetired).toBe("function");
      expect(typeof cutoverRetiredWorkApi.assertShipmentNotRetiredPg).toBe("function");
      expect(typeof cutoverRetiredWorkApi.retiredReceiptBatch).toBe("function");
      expect(typeof cutoverRetiredWorkApi.CutoverRetiredWorkError).toBe("function");

      expect(typeof runtimeAvailabilityApi.createAuthorityAwareInventoryAtpService).toBe("function");
      expect(typeof runtimeAvailabilityApi.createInventoryChannelQuantityRuntimeService).toBe("function");
      expect(typeof runtimeAvailabilityApi.loadAndLockRuntimeAuthority).toBe("function");

      expect(typeof quantityPublicationAdmissionApi.createChannelEbayQuantityRequestAdmission).toBe("function");
      expect(typeof quantityPublicationAdmissionApi.createDropshipEbayQuantityRequestAdmission).toBe("function");
      expect(typeof quantityPublicationAdmissionApi.quantityPublicationScopeLockKey).toBe("function");

      expect(typeof publicationTargetHoldApi.PostgresInventoryPublicationTargetHoldStore).toBe("function");
      expect(typeof publicationTargetHoldApi.PostgresInventoryPublicationTargetVariantHoldStore).toBe("function");

      expect(typeof dropshipDestinationHealthApi.dropshipStockDestinationSourceReadySql).toBe("function");

      expect(typeof claimExecutionApi.InventoryAvailabilityClaimRepositoryError).toBe("function");
      expect(typeof claimExecutionApi.AuthorityAwareReservationService).toBe("function");
      expect(typeof claimExecutionApi.createAuthorityAwareReservationRuntime).toBe("function");

      expect(typeof inventoryPlanningIndex.createAuthorityAwareInventoryAtpService).toBe("function");
      expect(typeof inventoryPlanningIndex.AuthorityAwareReservationService).toBe("function");
    });
  });

  describe("A-B5: Reservation authority contract ownership in inventory-planning", () => {
    it("routes runtime claim service and OMS consumers through inventory-planning/reservation-authority.api", () => {
      const runtimeClaimServiceSrc = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "server/modules/inventory-planning/application/inventory-availability-runtime-claim.service.ts",
        ),
        "utf8",
      );
      const wmsSyncSrc = fs.readFileSync(
        path.resolve(process.cwd(), "server/modules/oms/wms-sync.service.ts"),
        "utf8",
      );
      const repairSrc = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "server/modules/oms/application/historical-order-line-identity-repair.service.ts",
        ),
        "utf8",
      );

      expect(runtimeClaimServiceSrc).toContain('from "../reservation-authority.api"');
      expect(runtimeClaimServiceSrc).not.toContain("channels/reservation.service");
      expect(wmsSyncSrc).toContain('from "../inventory-planning/reservation-authority.api"');
      expect(wmsSyncSrc).not.toContain('from "../channels/reservation.service"');
      expect(repairSrc).toContain('from "../../inventory-planning/reservation-authority.api"');
      expect(repairSrc).not.toContain("channels/reservation.service");
    });
  });

  describe("A-04: Concurrent legacy whole-order release serialization & advisory lock", () => {
    it("serializes concurrent releaseOrderReservation calls for the same order so sibling reservations are never double-released", async () => {
      let ledgerOpenUnits = 3;
      let sharedLevelReservedUnits = 7; // 3 for order 42 + 4 for sibling order 99
      const releaseCalls: Array<{ orderId: number; orderItemId: number; qty: number }> = [];

      const selectChain = (rows: any[]) => {
        const chain: any = {
          from: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      };

      let selectStep = 0;
      const db = {
        select: vi.fn(() => {
          const step = selectStep % 3;
          selectStep += 1;
          if (step === 0) {
            return selectChain([
              { id: 700, orderId: 42, sku: "SKU-A", quantity: 3, catalogProductId: 3, productId: 9 },
            ]);
          }
          if (step === 1) {
            return selectChain([{ id: 9, sku: "SKU-A", productId: 3, unitsPerVariant: 1 }]);
          }
          return selectChain([
            { id: 1, warehouseLocationId: 10, reservedQty: sharedLevelReservedUnits, productVariantId: 9 },
          ]);
        }),
        execute: vi.fn(async () => {
          // Simulate async I/O delay before reading current open ledger balance
          await new Promise((r) => setTimeout(r, 15));
          return {
            rows: [
              {
                delta_sum: ledgerOpenUnits,
                legacy_reserves: 0,
                picked_units: 0,
                unreserved_units: 0,
              },
            ],
          };
        }),
      } as any;

      const mockInventoryCore = {
        releaseReservation: vi.fn(async (params: any) => {
          await new Promise((r) => setTimeout(r, 15));
          ledgerOpenUnits -= params.qty;
          sharedLevelReservedUnits -= params.qty;
          releaseCalls.push({
            orderId: params.orderId,
            orderItemId: params.orderItemId,
            qty: params.qty,
          });
        }),
      };
      const mockChannelSync = {
        queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined),
      };
      const mockAtpService = {
        getAtpPerVariant: vi.fn().mockResolvedValue([]),
        getProductInventoryStrategy: vi.fn().mockResolvedValue("physical_fungible"),
      };

      const svc = createReservationService(db, mockInventoryCore, mockChannelSync, mockAtpService);

      // Fire two concurrent whole-order releases for order 42
      const [first, second] = await Promise.all([
        svc.releaseOrderReservation(42, "concurrent_cancel_1"),
        svc.releaseOrderReservation(42, "concurrent_cancel_2"),
      ]);

      expect(first.released + second.released).toBe(1);
      expect(releaseCalls).toEqual([{ orderId: 42, orderItemId: 700, qty: 3 }]);
      expect(ledgerOpenUnits).toBe(0);
      // Sibling order 99's 4 reserved units remain untouched
      expect(sharedLevelReservedUnits).toBe(4);
    });

    it("acquires per-product advisory xact lock inside an authority-pinned Drizzle transaction before reading the ledger", async () => {
      const executedQueries: any[] = [];
      const selectRows = [
        [{ id: 700, orderId: 42, sku: "SKU-A", quantity: 2, catalogProductId: 3, productId: 9 }],
        [{ id: 9, sku: "SKU-A", productId: 3, unitsPerVariant: 1 }],
        [{ id: 1, warehouseLocationId: 10, reservedQty: 2, productVariantId: 9 }],
      ];
      const txDb: any = {
        _: { session: {} },
        select: vi.fn(() => {
          const rows = selectRows.shift() ?? [];
          const chain: any = {
            from: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
          };
          return chain;
        }),
        execute: vi.fn(async (q: any) => {
          executedQueries.push(q);
          if (executedQueries.length === 1) {
            return { rows: [] }; // pg_advisory_xact_lock
          }
          return {
            rows: [{ delta_sum: 2, legacy_reserves: 0, picked_units: 0, unreserved_units: 0 }],
          };
        }),
      };

      const mockInventoryCore = { releaseReservation: vi.fn(async () => {}) };
      const mockChannelSync = { queueSyncAfterInventoryChange: vi.fn().mockResolvedValue(undefined) };
      const mockAtpService = {
        getAtpPerVariant: vi.fn().mockResolvedValue([]),
        getProductInventoryStrategy: vi.fn().mockResolvedValue("physical_fungible"),
      };

      const svc = createReservationService({} as any, mockInventoryCore, mockChannelSync, mockAtpService);
      const res = await svc.releaseOrderReservation(42, "tx_pinned_cancel", "user:1", {
        disposition: "cancel",
        dbOverride: txDb,
      });

      expect(res.released).toBe(1);
      expect(executedQueries).toHaveLength(2);
      expect(JSON.stringify(executedQueries[0])).toContain("pg_advisory_xact_lock");
    });
  });

  describe("CI-05: Bounded AsyncSemaphore waiter queue & acquisition timeout in runtime claim executor", () => {
    function makeFakeLegacy(blockPromise: Promise<void>, onEnter?: () => void): ReservationServiceContract {
      return {
        reserveForOrder: vi.fn(),
        reserveOrder: vi.fn(async (orderId: number) => {
          onEnter?.();
          await blockPromise;
          return {
            orderId,
            reserved: 0,
            promised: 0,
            failed: [],
            totalBaseUnits: 0,
            totalPromisedBaseUnits: 0,
          };
        }),
        releaseOrderReservation: vi.fn(),
        releaseOrderItemReservation: vi.fn(),
        reconcileOrderDemand: vi.fn(),
        reconcileRefundOrderDemand: vi.fn(),
        reconcileCycleCountInventory: vi.fn(),
        reallocateOrphaned: vi.fn(),
        getOrderReservationStatus: vi.fn(),
        autoReserveOnSync: vi.fn(),
      };
    }

    function makeFakeCanonical(): InventoryAvailabilityClaimService {
      return new InventoryAvailabilityClaimService({
        getReservationStatus: vi.fn(),
        claimOrder: vi.fn(),
        replaceOrderClaim: vi.fn(),
        displaceForConfirmedShipment: vi.fn(),
        releaseOrderClaim: vi.fn(),
        executePackageOperation: vi.fn(),
        executeBuildOperation: vi.fn(),
        handoffBuildOperation: vi.fn(),
        pickClaimLine: vi.fn(),
        unpickClaimLine: vi.fn(),
        reconcileCycleCount: vi.fn(),
      });
    }

    function makeAuthorityClient() {
      return {
        query: vi.fn(async (statement: unknown) => {
          const sql = String(statement).trim();
          if (sql.startsWith("SELECT authority")) {
            return {
              rows: [{ authority: "legacy", authority_revision: "1", activation_run_id: null }],
            };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
    }

    it("rejects excess concurrent callers when the routing waiter queue reaches maxWaiters", async () => {
      let releaseBlocker!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      let firstEnteredResolve!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        firstEnteredResolve = resolve;
      });

      const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
        makeFakeLegacy(blocker, () => firstEnteredResolve()),
        makeFakeCanonical(),
        { connect: vi.fn(async () => makeAuthorityClient()), options: { max: 2 } } as never,
        { maxWaiters: 1, acquireTimeoutMs: 5_000 },
      );

      // Slot 1 is acquired immediately (capacity = floor(2/2) = 1)
      const op1 = executor.execute((ctx) => ctx.legacy.reserveOrder(1));
      await firstEntered;

      // Waiter 1 enters the queue (waiters.length = 1 === maxWaiters)
      const op2 = executor.execute((ctx) => ctx.legacy.reserveOrder(2));

      // Waiter 2 exceeds maxWaiters = 1 and fails fast
      await expect(
        executor.execute((ctx) => ctx.legacy.reserveOrder(3)),
      ).rejects.toMatchObject({
        code: "INVENTORY_CLAIM_ROUTING_QUEUE_EXHAUSTED",
      });

      releaseBlocker();
      await expect(Promise.all([op1, op2])).resolves.toHaveLength(2);
    });

    it("rejects queued waiters that exceed acquireTimeoutMs and recovers the routing slot cleanly", async () => {
      let releaseBlocker!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      let firstEnteredResolve!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        firstEnteredResolve = resolve;
      });

      const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
        makeFakeLegacy(blocker, () => firstEnteredResolve()),
        makeFakeCanonical(),
        { connect: vi.fn(async () => makeAuthorityClient()), options: { max: 2 } } as never,
        { maxWaiters: 5, acquireTimeoutMs: 25 },
      );

      const op1 = executor.execute((ctx) => ctx.legacy.reserveOrder(1));
      await firstEntered;

      await expect(
        executor.execute((ctx) => ctx.legacy.reserveOrder(2)),
      ).rejects.toMatchObject({
        code: "INVENTORY_CLAIM_ROUTING_ACQUIRE_TIMEOUT",
      });

      releaseBlocker();
      await expect(op1).resolves.toMatchObject({ orderId: 1 });

      // Subsequent operation after recovery succeeds
      await expect(
        executor.execute((ctx) => ctx.legacy.reserveOrder(3)),
      ).resolves.toMatchObject({ orderId: 3 });
    });
  });
});
