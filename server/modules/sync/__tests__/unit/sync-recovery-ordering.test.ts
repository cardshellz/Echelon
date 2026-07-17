import { describe, expect, it, vi } from "vitest";
import { SyncRecoveryService, type StageResult } from "../../sync-recovery.service";

function stage(name: string, data: Record<string, number> = {}): StageResult {
  return { name, ok: true, data };
}

describe("SyncRecoveryService ordering", () => {
  it("drains the local pipeline before source polling and completes recovered source rows", async () => {
    const service = new SyncRecoveryService({}, {});
    const calls: string[] = [];

    vi.spyOn(service, "runShopifyToOmsBackfill").mockImplementation(async () => {
      calls.push("shopify_to_oms");
      return stage("shopify_to_oms", { bridged: 17 });
    });
    vi.spyOn(service, "runOmsToWmsBackfill").mockImplementation(async (
      name = "oms_to_wms",
    ) => {
      calls.push(name);
      return stage(name, { synced: 17 });
    });
    vi.spyOn(service, "runWmsToShipStationBackfill").mockImplementation(
      async (name = "wms_to_shipstation") => {
        calls.push(name);
        return stage(name, { pushed: 17 });
      },
    );
    vi.spyOn(service, "runShopifyReconcile").mockImplementation(async () => {
      calls.push("shopify_reconcile");
      return stage("shopify_reconcile", { reconciled: 1 });
    });

    const result = await service.runAll();

    expect(calls).toEqual([
      "shopify_to_oms",
      "oms_to_wms",
      "wms_to_shipstation",
      "shopify_reconcile",
      "oms_to_wms_after_shopify_reconcile",
      "wms_to_shipstation_after_shopify_reconcile",
    ]);
    expect(result.allOk).toBe(true);
  });
});
