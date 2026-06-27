import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf8",
);
const ORDERS_SCHEMA_SRC = readFileSync(
  resolve(__dirname, "../../../../../shared/schema/orders.schema.ts"),
  "utf8",
);
const DB_SRC = readFileSync(
  resolve(__dirname, "../../../../db.ts"),
  "utf8",
);
const FULFILLMENT_PARTITION_MIGRATION = readFileSync(
  resolve(__dirname, "../../../../../migrations/111_oms_wms_fulfillment_partitions.sql"),
  "utf8",
);
const OMS_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../../../routes/oms.routes.ts"),
  "utf8",
);

describe("wms-sync duplicate WMS order / ShipStation push guard", () => {
  it("acquires a per-OMS-order advisory xact lock inside the create transaction", () => {
    // Serializes concurrent syncs of the SAME OMS order so two webhooks
    // (or webhook + reconcile sweep) cannot both insert a WMS order and
    // each push its own ShipStation order. Key space 918407 is distinct
    // from createShipmentForOrder's 918406.
    expect(WMS_SYNC_SRC).toMatch(/pg_advisory_xact_lock\(918407, \$\{omsOrderId\}\)/);
  });

  it("rechecks for an existing WMS order under the lock before inserting", () => {
    expect(WMS_SYNC_SRC).toMatch(/racedWmsOrder/);
    expect(WMS_SYNC_SRC).toMatch(/eq\(wmsOrders\.omsFulfillmentOrderId, String\(omsOrderId\)\)/);
    expect(WMS_SYNC_SRC).toMatch(
      /eq\(wmsOrders\.fulfillmentPartitionKey, DEFAULT_FULFILLMENT_PARTITION_KEY\)/,
    );
  });

  it("creates OMS-backed WMS orders in the default fulfillment partition", () => {
    expect(WMS_SYNC_SRC).toMatch(/const DEFAULT_FULFILLMENT_PARTITION_KEY = "default"/);
    expect(WMS_SYNC_SRC).toMatch(/fulfillmentPartitionKey: DEFAULT_FULFILLMENT_PARTITION_KEY/);
  });

  it("schema and migrations define the active OMS fulfillment partition backstop", () => {
    expect(ORDERS_SCHEMA_SRC).toMatch(/fulfillmentPartitionKey: varchar\("fulfillment_partition_key"/);
    expect(FULFILLMENT_PARTITION_MIGRATION).toContain("ADD COLUMN IF NOT EXISTS fulfillment_partition_key");
    expect(FULFILLMENT_PARTITION_MIGRATION).toContain(
      "uq_wms_orders_oms_fulfillment_partition_active",
    );
    expect(FULFILLMENT_PARTITION_MIGRATION).toContain("(COALESCE(warehouse_id, 0))");
    expect(FULFILLMENT_PARTITION_MIGRATION).toContain("fulfillment_partition_key");
    expect(FULFILLMENT_PARTITION_MIGRATION).toContain("DROP INDEX IF EXISTS wms.uq_wms_orders_oms_fulfillment_active");
    expect(DB_SRC).toContain("uq_wms_orders_oms_fulfillment_partition_active");
  });

  it("returns the winner's WMS order id without creating a duplicate when a race is detected", () => {
    expect(WMS_SYNC_SRC).toMatch(/racedExistingWmsOrderId/);
    expect(WMS_SYNC_SRC).toMatch(/reconcileExistingWmsOrderLines\(omsOrderId, racedId\)/);
    expect(WMS_SYNC_SRC).toMatch(/return racedId;/);
  });

  it("advisory lock is acquired before the create insert (ordering)", () => {
    const lockIdx = WMS_SYNC_SRC.indexOf("pg_advisory_xact_lock(918407");
    const createIdx = WMS_SYNC_SRC.indexOf("createOrderWithItems(txWmsOrderData");
    expect(lockIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(0);
    expect(lockIdx).toBeLessThan(createIdx);
  });

  it("legacy OMS-level push route no longer calls pushOrder (echelon-oms key)", () => {
    // The retired path created a second ShipStation order under a
    // different orderKey than the WMS shipment push. The route must now
    // delegate to the canonical pushShipment path.
    expect(OMS_ROUTES_SRC).not.toMatch(/ss\.pushOrder\(/);
    expect(OMS_ROUTES_SRC).toMatch(/push-to-shipstation/);
    expect(OMS_ROUTES_SRC).toMatch(/ss\.pushShipment\(shipmentId\)/);
  });

  it("legacy push route resolves the canonical non-voided WMS shipment", () => {
    expect(OMS_ROUTES_SRC).toMatch(/FROM wms\.outbound_shipments s/);
    expect(OMS_ROUTES_SRC).toMatch(/s\.status NOT IN \('voided', 'cancelled'\)/);
    expect(OMS_ROUTES_SRC).toMatch(/NO_WMS_SHIPMENT/);
  });
});
