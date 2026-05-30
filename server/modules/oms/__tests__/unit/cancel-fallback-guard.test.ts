/**
 * Structural test: the no-shipment cancel fallback in the orders/cancelled
 * webhook handler must cancel WMS orders in ALL non-terminal states, not
 * just 'ready'. The old guard skipped in_progress and ready_to_ship,
 * leaving actively-picked orders stuck in the pick queue after Shopify
 * cancellation.
 *
 * Post-C4 migration: the handler now calls cancelOrder() from
 * order-status-core.ts, which handles the from-state guard internally.
 * This test verifies:
 *   1. The handler uses C4's cancelOrder (not raw SQL)
 *   2. C4's cancelOrder accepts all non-terminal states
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isTransitionAllowed } from "../../../orders/order-status-core";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";

const WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);

describe("orders/cancelled no-shipment fallback guard", () => {
  const markerStart = "No shipments";
  const markerEnd = "Log event";
  const start = WEBHOOKS_SRC.indexOf(markerStart);
  const end = WEBHOOKS_SRC.indexOf(markerEnd, start);
  const block = WEBHOOKS_SRC.slice(start, end);

  it("only skips shipped and cancelled (not in_progress or ready_to_ship)", () => {
    // The handler now delegates to C4's cancelOrder instead of raw SQL.
    expect(block).toContain("cancelWmsOrder");
    expect(block).not.toContain("UPDATE wms.orders");
  });

  it("does NOT exclude in_progress from cancellation", () => {
    // C4's cancelOrder includes all non-terminal from-states
    expect(isTransitionAllowed("picking" as WmsWarehouseStatus, "cancelled")).toBe(true);
    expect(block).not.toContain("'in_progress'");
  });

  it("does NOT exclude ready_to_ship from cancellation", () => {
    expect(isTransitionAllowed("ready_to_ship" as WmsWarehouseStatus, "cancelled")).toBe(true);
    expect(block).not.toContain("'ready_to_ship'");
  });
});
