import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function readShipStationSource(): string {
  const omsDir = fileURLToPath(new URL("../..", import.meta.url));
  const subDir = resolve(omsDir, "shipstation");
  const subFiles = existsSync(subDir)
    ? readdirSync(subDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => readFileSync(resolve(subDir, f), "utf8"))
    : [];
  return [read("../../application/shipstation.service.ts"), ...subFiles].join("\n");
}

const SS_SRC = readShipStationSource();
const WMS_SHIPMENTS_REPO_SRC = read("../../../wms/infrastructure/outbound-shipments-mutations.repository.ts");

describe("P0.4 — SHIP_NOTIFY creation paths are closed", () => {
  it("every remaining outbound_shipments INSERT is a 918406-sanctioned child", () => {
    const directInserts = SS_SRC.match(/INSERT INTO wms\.outbound_shipments/g) ?? [];
    expect(directInserts.length).toBe(0);
    const delegatedInserts = SS_SRC.match(/await insertShipStationChildOutboundShipmentInWms\(/g) ?? [];
    // split child + combined child — and nothing else (legacy INSERT removed)
    expect(delegatedInserts.length).toBe(2);
    expect(WMS_SHIPMENTS_REPO_SRC).toContain("export async function insertShipStationChildOutboundShipmentInWms(");
    expect(WMS_SHIPMENTS_REPO_SRC).toContain("INSERT INTO wms.outbound_shipments");
    // Split child: transaction-scoped lock on the 918406 namespace. Combined
    // child: pinned-client session lock via withOrderShipmentLock, which binds
    // WMS_ORDER_SHIPMENT_LOCK_NAMESPACE (918406). The pooled
    // `SELECT pg_advisory_lock` idiom is forbidden: it serialized nothing.
    const xactLockCalls = SS_SRC.match(/pg_advisory_xact_lock\(918406/g) ?? [];
    const sessionLockCalls = SS_SRC.match(/await withOrderShipmentLock\(/g) ?? [];
    expect(xactLockCalls.length).toBeGreaterThanOrEqual(1);
    expect(sessionLockCalls.length).toBeGreaterThanOrEqual(1);
    expect(xactLockCalls.length + sessionLockCalls.length).toBeGreaterThanOrEqual(2);
    expect(SS_SRC).toContain("namespace: WMS_ORDER_SHIPMENT_LOCK_NAMESPACE");
    expect(SS_SRC).not.toContain("SELECT pg_advisory_lock(");
    expect(SS_SRC).not.toContain("SELECT pg_advisory_unlock(");
    // the legacy row shape must never come back
    expect(SS_SRC).not.toMatch(/VALUES \([^)]*'api', 'shipped'/);
    expect(SS_SRC).not.toMatch(/ON CONFLICT DO NOTHING\s*\n\s*RETURNING/);
  });

  it("the legacy path resolves one existing package or records review", () => {
    const block = SS_SRC.slice(
      SS_SRC.indexOf("async function processShipNotifyLegacy"),
      SS_SRC.indexOf("// ─── processShipNotify entry point"),
    );
    expect(block).toContain("exactTracking.length === 1");
    expect(block).toContain("active.length === 1");
    expect(block).toContain("recordLegacyShipNotifyAuthorityReview");
    expect(block).toContain("finalizeCanonicalShipNotifyPackage");
    expect(block).not.toContain("INSERT INTO wms.outbound_shipments");
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
