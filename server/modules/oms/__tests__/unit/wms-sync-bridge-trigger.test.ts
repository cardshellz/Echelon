import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf8",
);
const SHOPIFY_BRIDGE_SRC = readFileSync(
  resolve(__dirname, "../../shopify-bridge.ts"),
  "utf8",
);

// Regression coverage for the "orders stuck in OMS, never pushed to WMS→SS" bug.
//
// Root cause chain:
//   1. The Shopify reconciliation poller + LISTEN/NOTIFY bridge ingested orders
//      into OMS (bridgeShopifyOrderToOms) but never triggered the OMS→WMS sync.
//   2. The only safety net, backfillUnsynced, checked the wrong link column
//      (source_table_id instead of oms_fulfillment_order_id), so its NOT EXISTS
//      was always true and it only ever re-touched the 100 newest orders —
//      genuinely-stuck older orders were never reached.
//   3. shipped-but-unsynced orders (fulfilled out-of-band) would have been
//      resurrected into WMS, pushing a DUPLICATE order to the shipping engine.
describe("wms-sync: bridge-path OMS→WMS trigger + backfill correctness", () => {
  describe("Fix 1 — backfillUnsynced uses the canonical link column", () => {
    it("checks oms_fulfillment_order_id (live link), not the stale source_table_id-only predicate", () => {
      expect(WMS_SYNC_SRC).toMatch(
        /o\.source = 'oms'\s+AND o\.oms_fulfillment_order_id = oo\.id::text/,
      );
    });

    it("keeps the legacy shopify/source_table_id fallback so already-linked orders are not re-synced", () => {
      expect(WMS_SYNC_SRC).toMatch(
        /o\.source = 'shopify'\s+AND o\.source_table_id\s+= oo\.id::text/,
      );
    });

    it("excludes terminal + externally-fulfilled orders (no duplicate engine push)", () => {
      expect(WMS_SYNC_SRC).toMatch(
        /oo\.status\s+NOT IN \('cancelled', 'refunded', 'shipped'\)/,
      );
      expect(WMS_SYNC_SRC).toMatch(
        /COALESCE\(oo\.fulfillment_status, ''\) <> 'fulfilled'/,
      );
      expect(WMS_SYNC_SRC).toMatch(
        /COALESCE\(oo\.financial_status, ''\)\s+NOT IN \('refunded', 'voided'\)/,
      );
    });

    it("drains oldest-first so no stuck straggler is starved", () => {
      expect(WMS_SYNC_SRC).toMatch(/ORDER BY oo\.ordered_at ASC/);
    });
  });

  describe("Fix 2 — bridge path triggers the OMS→WMS sync", () => {
    it("captures the ingested OMS order and enqueues an OMS→WMS sync retry", () => {
      expect(SHOPIFY_BRIDGE_SRC).toMatch(
        /const omsOrder = await omsService\.ingestOrder\(/,
      );
      expect(SHOPIFY_BRIDGE_SRC).toMatch(/enqueueOmsWmsSyncRetry\(db, omsOrder\.id\)/);
    });

    it("does not enqueue a sync for cancelled / shipped / fulfilled orders", () => {
      expect(SHOPIFY_BRIDGE_SRC).toMatch(/status !== "cancelled"/);
      expect(SHOPIFY_BRIDGE_SRC).toMatch(/status !== "shipped"/);
      expect(SHOPIFY_BRIDGE_SRC).toMatch(/fulfillmentStatus !== "fulfilled"/);
    });
  });

  describe("Fix 3 — create-path guard against duplicate engine push", () => {
    it("refuses to create a WMS order when none exists and the OMS order is already shipped/fulfilled", () => {
      expect(WMS_SYNC_SRC).toMatch(/omsStatusLower === "shipped" \|\| omsFulfillmentLower === "fulfilled"/);
    });

    it("the guard sits after the existing-order check but before line-item fetch", () => {
      const existingReturnIdx = WMS_SYNC_SRC.indexOf("return wmsOrderId;");
      const guardIdx = WMS_SYNC_SRC.indexOf('omsStatusLower === "shipped"');
      const fetchLinesIdx = WMS_SYNC_SRC.indexOf("// 2. Fetch OMS line items");
      expect(existingReturnIdx).toBeGreaterThan(0);
      expect(guardIdx).toBeGreaterThan(existingReturnIdx);
      expect(fetchLinesIdx).toBeGreaterThan(guardIdx);
    });
  });
});
