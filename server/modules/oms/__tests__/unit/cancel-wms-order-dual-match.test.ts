/**
 * Structural test: cancelExistingWmsOrderForFinalOmsOrder must use the
 * same dual-match pattern as every other WMS lookup in the codebase —
 * matching both source='oms'/'ebay' via oms_fulfillment_order_id AND
 * source='shopify' via source_table_id.
 *
 * Without the dual-match, Shopify-sourced WMS orders are silently
 * skipped when the sync guard fires for a cancelled OMS order,
 * leaving the WMS order stuck in the pick queue.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("cancelExistingWmsOrderForFinalOmsOrder :: dual-match", () => {
  const fnStart = WMS_SYNC_SRC.indexOf("cancelExistingWmsOrderForFinalOmsOrder(omsOrderId: number)");
  const fnEnd = WMS_SYNC_SRC.indexOf("private async", fnStart + 1);
  const block = WMS_SYNC_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 500);

  it("matches source='oms'/'ebay' creation path via oms_fulfillment_order_id", () => {
    expect(block).toMatch(
      /source IN \('oms', 'ebay'\)\s+AND oms_fulfillment_order_id =/,
    );
  });

  it("matches the legacy source='shopify' creation path via source_table_id", () => {
    expect(block).toMatch(/source = 'shopify'\s+AND source_table_id\s*=/);
  });

  it("uses OR to combine both creation paths", () => {
    expect(block).toMatch(/OR\s*\(source = 'shopify'/);
  });
});
