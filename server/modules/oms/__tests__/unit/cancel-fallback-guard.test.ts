/**
 * Structural test: the no-shipment cancel fallback in the orders/cancelled
 * webhook handler must cancel WMS orders in ALL non-terminal states, not
 * just 'ready'. The old guard skipped in_progress and ready_to_ship,
 * leaving actively-picked orders stuck in the pick queue after Shopify
 * cancellation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(block).toMatch(/NOT IN \('shipped', 'cancelled'\)/);
  });

  it("does NOT exclude in_progress from cancellation", () => {
    expect(block).not.toContain("'in_progress'");
  });

  it("does NOT exclude ready_to_ship from cancellation", () => {
    expect(block).not.toContain("'ready_to_ship'");
  });
});
