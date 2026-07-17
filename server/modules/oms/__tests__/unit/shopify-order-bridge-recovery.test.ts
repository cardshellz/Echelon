import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  backfillShopifyOrders,
  bridgeShopifyOrderToOms,
} from "../../shopify-bridge";

const SHOPIFY_BRIDGE_SRC = readFileSync(
  resolve(__dirname, "../../shopify-bridge.ts"),
  "utf8",
);
const SHOPIFY_RECONCILIATION_SRC = readFileSync(
  resolve(__dirname, "../../../orders/shopify-order-reconciliation.ts"),
  "utf8",
);
const SYNC_RECOVERY_SRC = readFileSync(
  resolve(__dirname, "../../../sync/sync-recovery.service.ts"),
  "utf8",
);

function rawOrder(id: string, orderNumber: string) {
  return {
    id,
    order_number: orderNumber,
    channel_id: null,
    shop_domain: null,
    financial_status: "paid",
    fulfillment_status: null,
    cancelled_at: new Date("2026-07-14T05:00:00Z"),
    discount_codes: [],
    tags: [],
    created_at: new Date("2026-07-14T04:37:09Z"),
  };
}

describe("Shopify raw-to-OMS bridge recovery", () => {
  it("uses schema-qualified channel authority and never silently returns on routing failure", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [rawOrder("gid://shopify/Order/12161715011743", "#60303")] })
      .mockResolvedValueOnce({ rows: [] });
    const omsService = { ingestOrder: vi.fn() };

    await expect(
      bridgeShopifyOrderToOms(
        { execute },
        omsService as any,
        "gid://shopify/Order/12161715011743",
      ),
    ).rejects.toThrow("No Shopify channel route for raw order #60303");
    expect(omsService.ingestOrder).not.toHaveBeenCalled();
    expect(SHOPIFY_BRIDGE_SRC).toContain("FROM channels.channels c");
    expect(SHOPIFY_BRIDGE_SRC).toContain("JOIN channels.channel_connections cc");
    expect(SHOPIFY_BRIDGE_SRC).not.toMatch(/FROM channel_connections\b/);
  });

  it("continues past one bad row and reports only confirmed OMS ingestions as bridged", async () => {
    const firstId = "gid://shopify/Order/12161715011743";
    const secondId = "gid://shopify/Order/12161738408095";
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { id: firstId, order_number: "#60303" },
          { id: secondId, order_number: "#60304" },
        ],
      })
      .mockResolvedValueOnce({ rows: [rawOrder(firstId, "#60303")] })
      .mockResolvedValueOnce({ rows: [{ channel_id: 36 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [rawOrder(secondId, "#60304")] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const omsService = {
      ingestOrder: vi.fn().mockResolvedValue({ id: 259101 }),
    };

    const result = await backfillShopifyOrders(
      { execute },
      omsService as any,
      50,
    );

    expect(result).toMatchObject({ attempted: 2, bridged: 1, failed: 1 });
    expect(result.failures[0]).toContain("#60304");
    expect(omsService.ingestOrder).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(8);
  });

  it("bounds recovery at the durable cutover and drains oldest missing orders first", () => {
    expect(SHOPIFY_BRIDGE_SRC).toContain("so.created_at >= checkpoint.monitor_started_at");
    expect(SHOPIFY_BRIDGE_SRC).toContain("ORDER BY so.created_at ASC");
    expect(SHOPIFY_BRIDGE_SRC).toContain("last_candidates");
    expect(SHOPIFY_BRIDGE_SRC).toContain("last_bridged");
    expect(SHOPIFY_BRIDGE_SRC).toContain("last_failed");
  });

  it("does not advance the Shopify source cursor after bridge or pagination failure", () => {
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("if (result.failed === 0)");
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("checkpoint was not advanced");
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("SHOPIFY_RECONCILIATION_MAX_PAGES");
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("warehouse.echelon_settings");
  });

  it("uses canonical source identity and OMS authority to detect ingestion gaps", () => {
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("normalizeShopifyOrderGid(order.id)");
    expect(SHOPIFY_RECONCILIATION_SRC).toContain("JOIN oms.oms_orders oo");
    expect(SHOPIFY_RECONCILIATION_SRC).not.toContain(
      "SELECT source_table_id FROM wms.orders",
    );
  });

  it("drains locally captured orders before calling the remote source poller", () => {
    expect(SYNC_RECOVERY_SRC.indexOf("this.runShopifyToOmsBackfill()"))
      .toBeLessThan(SYNC_RECOVERY_SRC.indexOf("this.runShopifyReconcile()"));
    expect(SYNC_RECOVERY_SRC).toContain("oms_to_wms_after_shopify_reconcile");
  });
});
