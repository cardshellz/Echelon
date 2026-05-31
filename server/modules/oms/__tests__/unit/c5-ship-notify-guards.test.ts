/**
 * C5 Phase 3 tests: SHIP_NOTIFY cascade guard improvements.
 *
 * Tests for:
 * - D-DUPEVENT: recordShipmentEventV2 handles unique constraint on replay
 * - D-NOMATCH: processShipmentNotification surfaces no-match shipments
 * - D-FULLQTY: applyShipmentQuantitiesToWmsOrderItems is idempotent
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHIPSTATION_SRC = readFileSync(
  fileURLToPath(new URL("../../shipstation.service.ts", import.meta.url)),
  "utf8",
);

// ─── D-DUPEVENT structural checks ──────────────────────────────────

describe("D-DUPEVENT: recordShipmentEventV2 dedup", () => {
  it("catches unique constraint violation (23505) on shipment_dedup", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function recordShipmentEventV2"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function recordShipmentEventV2") + 10,
      ),
    );
    expect(fnBlock).toContain('err?.code === "23505"');
    expect(fnBlock).toContain("shipment_dedup");
  });

  it("still inserts the event (not skipping the INSERT)", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function recordShipmentEventV2"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function recordShipmentEventV2") + 10,
      ),
    );
    expect(fnBlock).toContain("db.insert(omsOrderEvents)");
  });

  it("migration exists for the unique index", () => {
    const migrationPath =
      "/home/user/Echelon/migrations/0571_oms_order_events_ship_dedup.sql";
    expect(existsSync(migrationPath)).toBe(true);

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("uq_oms_order_events_shipment_dedup");
    expect(sql).toContain("shipped_via_shipstation");
    expect(sql).toContain("wmsShipmentId");
  });
});

// ─── D-NOMATCH structural checks ───────────────────────────────────

describe("D-NOMATCH: no-match SHIP_NOTIFY surfacing", () => {
  it("processShipmentNotification logs structured error on no-match", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function processShipmentNotification"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function processShipmentNotification") + 10,
      ),
    );
    expect(fnBlock).toContain("ship_notify_no_match");
    expect(fnBlock).toContain("JSON.stringify");
  });

  it("persists a dead-letter event for unmatched shipments", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("D-NOMATCH"),
      SHIPSTATION_SRC.indexOf("return { processed: false }",
        SHIPSTATION_SRC.indexOf("D-NOMATCH")),
    );
    expect(fnBlock).toContain("db.insert(omsOrderEvents)");
    expect(fnBlock).toContain("ship_notify_no_match");
    expect(fnBlock).toContain("requiresReview");
  });

  it("includes ShipStation identifiers in dead letter", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("D-NOMATCH"),
      SHIPSTATION_SRC.indexOf("return { processed: false }",
        SHIPSTATION_SRC.indexOf("D-NOMATCH")),
    );
    expect(fnBlock).toContain("ssShipmentId");
    expect(fnBlock).toContain("ssOrderId");
    expect(fnBlock).toContain("ssOrderKey");
    expect(fnBlock).toContain("trackingNumber");
  });

  it("does not throw on dead-letter persistence failure", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("D-NOMATCH"),
      SHIPSTATION_SRC.indexOf("return { processed: false }",
        SHIPSTATION_SRC.indexOf("D-NOMATCH")),
    );
    expect(fnBlock).toContain("catch (deadLetterErr");
  });
});

// ─── D-FULLQTY structural checks ───────────────────────────────────

describe("D-FULLQTY: idempotent quantity application", () => {
  it("derives fulfilled_quantity from shipment items (not additive)", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItems",
      ),
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItemsFallback",
      ),
    );
    // Should NOT have the old additive pattern
    expect(fnBlock).not.toContain(
      "COALESCE(fulfilled_quantity, 0) + ${qty}",
    );
    // Should derive from shipment items via subquery
    expect(fnBlock).toContain("outbound_shipment_items");
    expect(fnBlock).toContain("SUM(osi.qty)");
  });

  it("uses LEAST to cap at order item quantity", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItems",
      ),
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItemsFallback",
      ),
    );
    expect(fnBlock).toContain("LEAST(");
    expect(fnBlock).toContain("oi.quantity");
  });

  it("only counts shipped/labeled/queued shipments", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItems",
      ),
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItemsFallback",
      ),
    );
    expect(fnBlock).toContain("shipped");
    expect(fnBlock).toContain("labeled");
    expect(fnBlock).toContain("queued");
  });

  it("deduplicates order item IDs", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItems",
      ),
      SHIPSTATION_SRC.indexOf(
        "async function applyShipmentQuantitiesToWmsOrderItemsFallback",
      ),
    );
    expect(fnBlock).toContain("new Set(orderItemIds)");
  });
});
