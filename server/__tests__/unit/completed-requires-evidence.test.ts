import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Orders #62269 (AU) and #62226 (CA) reached the warehouse with every line
 * quantity at zero. The status rollup in wms-sync read "nothing left to pick"
 * as "this order is finished" and answered 'completed' - with no legal
 * transition check and no completed_at. 'completed' is terminal, so the repair
 * pass skipped both orders for three days while a corrected quantity sat in OMS.
 *
 * Of 18 completions in the 30 days before the fix, the 13 legitimate ones all
 * carried a completed_at; the rollup never stamps one. It had produced no
 * legitimate completions at all.
 */

const root = (p: string) => readFileSync(resolve(__dirname, "../../..", p), "utf8");

const MIGRATION = root("migrations/0629_wms_orders_completed_requires_timestamp.sql");
const WMS_SYNC = root("server/modules/oms/wms-sync.service.ts");
const STATUS_CORE = root("server/modules/orders/order-status-core.ts");

describe("wms-sync status rollup", () => {
  it("no longer answers 'completed' from an absence of pickable rows", () => {
    expect(WMS_SYNC).not.toMatch(/ELSE 'completed'/);
  });

  it("preserves the existing status when it has nothing to go on", () => {
    // Matching its three sibling writers, none of which invent a status.
    expect(WMS_SYNC).toMatch(/ELSE w\.warehouse_status\s*\n\s*END,/);
  });

  it("still resolves the two states it can actually evidence", () => {
    expect(WMS_SYNC).toMatch(/THEN 'ready'/);
    expect(WMS_SYNC).toMatch(/= 0 THEN 'cancelled'/);
  });
});

describe("the guarded completion path stays intact", () => {
  it("stamps completed_at whenever it completes or ships an order", () => {
    // This is what makes the constraint free for the legitimate path. If a
    // transition to a terminal state ever stops stamping, the constraint turns
    // that into a loud failure rather than another phantom completion.
    const stamped = STATUS_CORE.match(/setCompletedAt: true/g) ?? [];
    expect(stamped.length).toBe(2); // completeOrder + shipOrder
    expect(STATUS_CORE).toMatch(/completed_at = \$\{now\}/);
  });
});

describe("migration 0629", () => {
  it("repairs shipped orders from shipment evidence, not from row shape", () => {
    expect(MIGRATION).toMatch(/warehouse_status = 'shipped'/);
    expect(MIGRATION).toMatch(/completed_at = evidence\.last_ship_date/);
  });

  it("refuses to close out a partially shipped order", () => {
    // Without this the rule could stamp a ship date on an order that still has
    // an open parcel. None exist today; the guard is why none can appear later.
    expect(MIGRATION).toMatch(
      /HAVING COUNT\(\*\) FILTER \(WHERE shipment\.status <> 'shipped'\) = 0/,
    );
  });

  it("installs the invariant after the backfill, never before", () => {
    const backfill = MIGRATION.indexOf("UPDATE wms.orders");
    const constraint = MIGRATION.indexOf("ADD CONSTRAINT");
    expect(backfill).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(backfill);
  });

  it("states the invariant as: completed must say when", () => {
    expect(MIGRATION).toMatch(
      /CHECK \(warehouse_status <> 'completed' OR completed_at IS NOT NULL\)/,
    );
  });
});
