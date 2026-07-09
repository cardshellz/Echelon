import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * P0.4 — the legacy SHIP_NOTIFY path never creates shipment rows.
 *
 * Its old INSERT ('shipped', external_fulfillment_id NULL) sat behind an
 * UNTARGETED "ON CONFLICT DO NOTHING" that no unique index backed, so
 * replayed webhooks piled up duplicate shipped rows and inflated fulfillment
 * sums. Now: resolve (replay-by-tracking → adopt active row) or flag
 * ('ship_notify_unresolved' / legacy_no_shipment_row) — never fabricate.
 * The ONLY sanctioned creators left in this file are the 918406-locked
 * split/combined child inserts, both deduped on external_fulfillment_id.
 */

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const SS_SRC = read("../../shipstation.service.ts");

describe("P0.4 — SHIP_NOTIFY creation paths are closed", () => {
  it("every remaining outbound_shipments INSERT is a 918406-sanctioned child", () => {
    const inserts = SS_SRC.match(/INSERT INTO wms\.outbound_shipments/g) ?? [];
    // split child + combined child — and nothing else (legacy INSERT removed)
    expect(inserts.length).toBe(2);
    const lockCalls = SS_SRC.match(/pg_advisory_lock\(918406/g) ?? [];
    expect(lockCalls.length).toBeGreaterThanOrEqual(2);
    // the legacy row shape must never come back
    expect(SS_SRC).not.toMatch(/VALUES \([^)]*'api', 'shipped'/);
    expect(SS_SRC).not.toMatch(/ON CONFLICT DO NOTHING\s*\n\s*RETURNING/);
  });

  it("the legacy path resolves (replay → adopt) or flags — in that order", () => {
    const block = SS_SRC.slice(
      SS_SRC.indexOf("P0.4: RESOLVE-OR-FLAG"),
      SS_SRC.indexOf("legacy_no_shipment_row"),
    );
    const replay = block.indexOf("AND tracking_number = ${trackingNumber}");
    const adopt = block.indexOf("AND status IN ('planned', 'queued', 'labeled', 'on_hold')");
    expect(replay).toBeGreaterThan(-1);
    expect(adopt).toBeGreaterThan(replay);
    expect(SS_SRC).toContain("'ship_notify_unresolved'");
  });

  it("outbound_shipment_tracking_dedup migration voids duplicates and adds the (order, tracking) shipped unique", () => {
    // Renumbered 119 -> 121 to resolve a prefix collision with the already-applied
    // 119_shipping_zone_seed. Internal SQL identifiers keep their _119 suffix.
    const sql = read("../../../../../migrations/121_outbound_shipment_tracking_dedup.sql");
    expect(sql).toContain("dup_ship_notify_legacy_voided_119");
    expect(sql).toContain("uq_outbound_shipments_shipped_order_tracking");
    expect(sql).toContain("WHERE status = 'shipped' AND tracking_number IS NOT NULL");
  });
});
