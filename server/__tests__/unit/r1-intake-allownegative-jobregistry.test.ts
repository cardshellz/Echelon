import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRegisteredJobsStatusSnapshot,
  registerScheduledJob,
  resetJobRegistryForTest,
} from "../../infrastructure/job-registry";
import {
  EXTERNAL_RUNTIME_JOBS,
  registerExternalRuntimeJobs,
} from "../../infrastructure/runtime-job-catalog";
import { createShopifyOrderIntakeAdapter } from "../../modules/oms/adapters/shopify-order-intake.adapter";
import { InventoryUseCases } from "../../modules/inventory/application/inventory.use-cases";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("Batch R-1 — P3.1 Cancel/Refund Adapter Wiring, P0.8 3PL Shortfall Clamp, & P1.5 Full Job Registry Convergence", () => {
  beforeEach(() => {
    resetJobRegistryForTest();
  });

  afterEach(() => {
    resetJobRegistryForTest();
    vi.restoreAllMocks();
  });

  describe("P3.1 — Shopify orders/cancelled and refunds/create route through ChannelOrderAdapter", () => {
    const omsWebhooksSrc = readRepoFile("server/modules/oms/application/oms-webhooks.ts");
    const adapter = createShopifyOrderIntakeAdapter();

    it("wires shopifyOrderIntakeAdapter.normalizeCancel in orders/cancelled and normalizeRefund in refunds/create", () => {
      const cancelledStart = omsWebhooksSrc.indexOf('"/api/oms/webhooks/orders/cancelled"');
      const fulfilledStart = omsWebhooksSrc.indexOf('"/api/oms/webhooks/orders/fulfilled"');
      const cancelledBlock = omsWebhooksSrc.slice(cancelledStart, fulfilledStart);

      expect(cancelledBlock).toContain("shopifyOrderIntakeAdapter.normalizeCancel(");
      expect(cancelledBlock).toContain("normalizedCancel.externalOrderId");

      const refundStart = omsWebhooksSrc.indexOf('"/api/oms/webhooks/refunds/create"');
      const refundBlock = omsWebhooksSrc.slice(refundStart);

      expect(refundBlock).toContain("shopifyOrderIntakeAdapter.normalizeRefund(");
      expect(refundBlock).toContain("refundOrderGid");
      expect(refundBlock).toContain("refundOrderNumericId");
      expect(refundBlock).toContain("const thisRefundCents = normalizedRefund.refundAmountCents;");
    });

    it("normalizes Shopify cancel payloads (both GID and numeric ID) and filters failed gateway refund transactions", () => {
      const cancelEvent = adapter.normalizeCancel(
        {
          id: 99112233,
          admin_graphql_api_id: "gid://shopify/Order/99112233",
          cancel_reason: "customer",
          cancelled_at: "2026-11-23T12:00:00.000Z",
        },
        { channelId: 36 },
      );
      expect(cancelEvent).toMatchObject({
        externalOrderId: "99112233",
        channelId: 36,
        source: "shopify",
        reason: "customer",
      });

      const refundEvent = adapter.normalizeRefund(
        {
          id: 77001,
          order_id: 99112233,
          created_at: "2026-11-23T13:00:00.000Z",
          transactions: [
            { amount: "12.50", status: "success" },
            { amount: "99.99", status: "failure" },
          ],
          refund_line_items: [
            {
              line_item_id: 501,
              quantity: 2,
              subtotal: "12.50",
              restock_type: "no_restock",
            },
          ],
        },
        { channelId: 36 },
      );
      expect(refundEvent).toMatchObject({
        externalOrderId: "99112233",
        externalRefundId: "77001",
        channelId: 36,
        refundAmountCents: 1250,
      });
    });
  });

  describe("P0.8 (#3) — 3PL sync never passes allowNegative: true and clamps negative feeds at 0", () => {
    it("removes allowNegative: true from syncWarehouse in inventory.use-cases.ts", () => {
      const src = readRepoFile("server/modules/inventory/application/inventory.use-cases.ts");
      const syncStart = src.indexOf("async syncWarehouse(warehouseId: number)");
      const syncEnd = src.indexOf("async syncAll():", syncStart);
      expect(syncStart).toBeGreaterThan(-1);
      expect(syncEnd).toBeGreaterThan(syncStart);
      const syncBlock = src.slice(syncStart, syncEnd);

      expect(syncBlock).not.toContain("allowNegative");
      expect(syncBlock).toContain("Math.max(0, qty)");
      expect(syncBlock).toContain("3PL reported negative quantity");
    });

    it("clamps negative 3PL feed quantities to 0, records shortfall error, and calls adjustInventory without allowNegative", async () => {
      const selectResults = [
        [
          {
            id: 4,
            code: "3PL-EAST",
            inventorySourceType: "channel",
            inventorySourceConfig: { channelId: 12 },
            shopifyLocationId: "778899",
          },
        ],
        [
          {
            channelId: 12,
            shopDomain: "3pl-test.myshopify.com",
            accessToken: "shpat_test",
            apiVersion: "2024-10",
          },
        ],
        [{ id: 900, code: "3PL-EAST-VIRTUAL" }],
      ];

      let selectIdx = 0;
      let executeIdx = 0;
      const dbMock: any = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => selectResults[selectIdx++] ?? []),
            })),
          })),
        })),
        execute: vi.fn(async () => {
          executeIdx += 1;
          // First execute is assertLegacyQuantityImportAllowed (0 verified opening rows => legacy sync allowed)
          if (executeIdx === 1) {
            return { rows: [] };
          }
          // Second execute is product_variants lookup
          return {
            rows: [{ id: 88, shopify_inventory_item_id: "555" }],
          };
        }),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      };

      const storageMock = {
        getInventoryLevelByLocationAndVariant: vi.fn().mockResolvedValue({
          id: 1,
          variantQty: 7,
        }),
      } as any;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          json: async () => ({
            inventory_levels: [{ inventory_item_id: 555, available: -5 }],
          }),
        }),
      );

      const uc = new InventoryUseCases(dbMock, storageMock, {} as any);
      const adjustSpy = vi.spyOn(uc, "adjustInventory").mockResolvedValue({} as any);

      const res = await uc.syncWarehouse(4);

      expect(adjustSpy).toHaveBeenCalledTimes(1);
      expect(adjustSpy).toHaveBeenCalledWith({
        productVariantId: 88,
        warehouseLocationId: 900,
        qtyDelta: -7,
        reason: "3PL sync (set to 0 from raw -5, delta -7)",
      });
      expect(res.synced).toBe(1);
      expect(res.errors).toEqual([
        "Variant 88: 3PL reported negative quantity (-5); clamped to 0 and flagged shortfall",
      ]);
    });
  });

  describe("P1.5 — Full Runtime Background Job Catalog Convergence", () => {
    it("registers all 43 external runtime jobs + 7 loop-managed reconcilers without advisoryLockId collisions and maps persistedRunKey telemetry", async () => {
      registerExternalRuntimeJobs();

      // Also register the 7 loop-managed reconciler lock IDs (autoStartLoop: false for test)
      const loopManagedLocks = [918501, 918502, 918503, 918504, 918505, 918506, 918507];
      loopManagedLocks.forEach((lockId, idx) => {
        registerScheduledJob({
          name: `loop.managed_${idx}`,
          cadenceMs: 60_000,
          advisoryLockId: lockId,
          writableStates: [],
          deadLetterPolicy: "none",
          autoStartLoop: false,
          run: async () => {},
        });
      });

      const snapshot = await getRegisteredJobsStatusSnapshot({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              job_key: "oms_flow_reconciliation",
              last_completed_at: new Date("2026-11-23T18:00:00.000Z"),
            },
            {
              job_key: "fulfillment_outbound",
              last_completed_at: new Date("2026-11-23T18:05:00.000Z"),
            },
          ],
        }),
      });

      expect(EXTERNAL_RUNTIME_JOBS.length).toBe(43);
      expect(snapshot.length).toBe(50);

      const uniqueLocks = new Set(snapshot.map((j) => j.advisoryLockId));
      expect(uniqueLocks.size).toBe(snapshot.length);

      const flowRecon = snapshot.find((j) => j.name === "oms.flow_reconciliation");
      expect(flowRecon?.advisoryLockId).toBe(918405);
      expect(flowRecon?.concurrencyMechanism).toBe("session_advisory_lock");
      expect(flowRecon?.persistedLastCompletedAt).toBe("2026-11-23T18:00:00.000Z");

      const outboundSweeper = snapshot.find((j) => j.name === "oms.fulfillment_sweeper_outbound");
      expect(outboundSweeper?.advisoryLockId).toBe(8484);
      expect(outboundSweeper?.persistedLastCompletedAt).toBe("2026-11-23T18:05:00.000Z");

      const retryWorker = snapshot.find((j) => j.name === "oms.webhook_retry_worker");
      expect(retryWorker?.concurrencyMechanism).toBe("row_skip_locked");
      expect(retryWorker?.deadLetterPolicy).toBe("webhook_retry_queue");

      const indexSrc = readRepoFile("server/index.ts");
      expect(indexSrc).toContain("registerExternalRuntimeJobs();");
    });
  });
});
