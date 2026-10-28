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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SHIPSTATION_SRC = readFileSync(
  fileURLToPath(new URL("../../shipstation.service.ts", import.meta.url)),
  "utf8",
);
const PROJECTION_SRC = readFileSync(
  fileURLToPath(new URL("../../../wms/channel-fulfillment-projection.repository.ts", import.meta.url)),
  "utf8",
);
const quantityProjectionSql: string[] = [];
function collectQuantityProjection(node: ts.Node): void {
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === "sql"
    && /UPDATE\s+wms\.order_items\b/.test(node.template.getText())) {
    quantityProjectionSql.push(node.template.getText());
  }
  ts.forEachChild(node, collectQuantityProjection);
}
collectQuantityProjection(ts.createSourceFile("projection.ts", PROJECTION_SRC, ts.ScriptTarget.Latest, true));

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
    const migrationPath = resolve(
      process.cwd(),
      "migrations/0571_oms_order_events_ship_dedup.sql",
    );
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

  it("persists a WMS reconciliation exception for unmatched shipments", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("D-NOMATCH"),
      SHIPSTATION_SRC.indexOf("return { processed: false }",
        SHIPSTATION_SRC.indexOf("D-NOMATCH")),
    );
    expect(fnBlock).toContain("recordShipNotifyNoMatchException");
    expect(fnBlock).toContain("ship_notify_no_match");
    expect(SHIPSTATION_SRC).toContain("wms.reconciliation_exceptions");
    expect(SHIPSTATION_SRC).toContain("manual_review");
    expect(fnBlock).not.toContain("orderId: 0");
  });

  it("includes ShipStation identifiers in the exception details", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function recordShipNotifyNoMatchException"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function recordShipNotifyNoMatchException") + 10,
      ),
    );
    expect(fnBlock).toContain("ssShipmentId");
    expect(fnBlock).toContain("ssOrderId");
    expect(fnBlock).toContain("ssOrderKey");
    expect(fnBlock).toContain("trackingNumber");
    expect(fnBlock).toContain("idempotency_key");
  });

  it("does not throw on exception persistence failure", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("D-NOMATCH"),
      SHIPSTATION_SRC.indexOf("return { processed: false }",
        SHIPSTATION_SRC.indexOf("D-NOMATCH")),
    );
    expect(fnBlock).toContain("catch (exceptionErr");
  });
});

// ─── D-FULLQTY structural checks ───────────────────────────────────

describe("D-FULLQTY: canonical idempotent quantity projection", () => {
  it("derives fulfilled_quantity from canonical physical shipment items", () => {
    // Header identity projection may read original source identities. Enforce
    // quantity ownership on the actual order-item write, not unrelated reads.
    expect(quantityProjectionSql).toHaveLength(1);
    expect(quantityProjectionSql[0]).toContain("FROM wms.effective_physical_shipment_items item");
    expect(quantityProjectionSql[0]).toContain("SUM(item.quantity_shipped)::int AS shipped_quantity");
    expect(quantityProjectionSql[0]).not.toContain("FROM wms.outbound_shipment_items");
    expect(quantityProjectionSql[0]).not.toContain("COALESCE(fulfilled_quantity, 0) +");
  });

  it("uses LEAST to cap at order item quantity", () => {
    expect(quantityProjectionSql[0]).toContain(
      "SET fulfilled_quantity = LEAST(order_item.quantity, shipped.shipped_quantity)",
    );
  });

  it("counts shipped and subsequently returned packages, never unshipped labels", () => {
    expect(quantityProjectionSql[0]).toContain("AND package.status IN ('shipped', 'returned')");
    expect(quantityProjectionSql[0]).not.toMatch(/package\.status\s+IN\s*\([^)]*'queued'/);
    expect(quantityProjectionSql[0]).not.toMatch(/package\.status\s+IN\s*\([^)]*'labeled'/);
    expect(quantityProjectionSql[0]).not.toMatch(/package\.status\s+IN\s*\([^)]*'voided'/);
  });

  it("projects each affected WMS line by canonical line identity", () => {
    expect(quantityProjectionSql[0]).toContain("SELECT DISTINCT item.wms_order_item_id");
    expect(quantityProjectionSql[0]).toContain("WHERE order_item.id = shipped.wms_order_item_id");
    expect(SHIPSTATION_SRC).not.toContain("UPDATE wms.order_items");
  });
});
