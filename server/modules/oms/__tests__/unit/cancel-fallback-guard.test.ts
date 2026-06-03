/**
 * Structural test: cancellation cascade delegates to cancelOrder from
 * order-status-core when no shipments exist, and C4's cancelOrder
 * accepts all non-terminal states (not just 'ready').
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

describe("cancelOrderCascade no-shipment fallback guard", () => {
  function extractCancelOrderCascade(): string {
    const start = WEBHOOKS_SRC.indexOf("export async function cancelOrderCascade(");
    const nextExport = WEBHOOKS_SRC.indexOf("/**\n * Apply a Shopify `refunds/create`");
    return WEBHOOKS_SRC.substring(start, nextExport);
  }

  it("uses C4 cancelOrder (not raw SQL) when no shipments exist", () => {
    const fn = extractCancelOrderCascade();
    expect(fn).toContain("cancelWmsOrder(db, wmsRow.id");
    expect(fn).not.toMatch(/UPDATE wms\.orders.*SET.*status.*=.*'cancelled'/);
  });

  it("does NOT exclude in_progress from cancellation", () => {
    expect(isTransitionAllowed("picking" as WmsWarehouseStatus, "cancelled")).toBe(true);
  });

  it("does NOT exclude ready_to_ship from cancellation", () => {
    expect(isTransitionAllowed("ready_to_ship" as WmsWarehouseStatus, "cancelled")).toBe(true);
  });
});
