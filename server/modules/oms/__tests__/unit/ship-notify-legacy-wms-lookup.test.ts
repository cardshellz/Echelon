/**
 * Regression test for the SHIP_NOTIFY legacy WMS-order lookup.
 *
 * Bug: the legacy (echelon-oms-<id>) SHIP_NOTIFY branch looked up the WMS
 * order with `source IN ('oms','ebay') AND oms_fulfillment_order_id = <id>`.
 * That misses WMS rows created by the legacy Shopify direct-write / manual
 * path, which use `source = 'shopify'` linked via `source_table_id` (see the
 * documented dual-match in oms-webhooks.ts and the pick-queue join in
 * orders.storage.ts). When the row wasn't found, SHIP_NOTIFY fell through to
 * the OMS-only branch and NEVER set wms.orders.warehouse_status = 'shipped',
 * leaving the order stuck in the pick queue forever (order 58022).
 *
 * The lookup must match BOTH creation paths, exactly like every other WMS
 * lookup in the codebase.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SHIPSTATION_SRC = readFileSync(
  resolve(__dirname, "../../shipstation.service.ts"),
  "utf-8",
);

describe("SHIP_NOTIFY legacy WMS-order lookup :: source/link dual-match", () => {
  // Isolate the legacy-path lookup block.
  const legacyBlock = SHIPSTATION_SRC.slice(
    SHIPSTATION_SRC.indexOf("LEGACY PATH: SHIP_NOTIFY carried echelon-oms"),
    SHIPSTATION_SRC.indexOf("const hasWmsOrder"),
  );

  it("matches the source='oms'/'ebay' creation path via oms_fulfillment_order_id", () => {
    expect(legacyBlock).toMatch(
      /source IN \('oms', 'ebay'\) AND oms_fulfillment_order_id =/,
    );
  });

  it("ALSO matches the legacy source='shopify' creation path via source_table_id", () => {
    expect(legacyBlock).toMatch(/source = 'shopify'\s+AND source_table_id\s+=/);
  });

  it("does not use the old shopify-blind filter that stranded Shopify orders", () => {
    // The buggy form was a bare `oms_fulfillment_order_id = X AND source IN
    // ('oms','ebay')` with no OR-branch for shopify/source_table_id.
    expect(legacyBlock).toContain("source_table_id");
    // The query must be an OR of the two creation paths.
    expect(legacyBlock).toMatch(/\)\s*OR \(source = 'shopify'/);
  });
});
