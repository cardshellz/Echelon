import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf8",
);

describe("wms-sync existing order reconciliation", () => {
  it("does not return before reconciling missing WMS lines", () => {
    expect(WMS_SYNC_SRC).toMatch(/reconcileExistingWmsOrderLines\(omsOrderId, wmsOrderId\)/);
    expect(WMS_SYNC_SRC).toMatch(/const missingLines = omsLines\.filter/);
  });

  it("adds reconciled shippable lines to planned outbound shipments and requeues ShipStation", () => {
    expect(WMS_SYNC_SRC).toMatch(/eq\(outboundShipments\.status, "planned"\)/);
    expect(WMS_SYNC_SRC).toMatch(/INSERT INTO wms\.outbound_shipment_items/);
    expect(WMS_SYNC_SRC).toMatch(/WHERE NOT EXISTS \(/);
    expect(WMS_SYNC_SRC).toMatch(/enqueueShipStationShipmentPushRetry/);
  });

  it("does not reconcile cancelled or refunded OMS orders back into WMS work", () => {
    expect(WMS_SYNC_SRC).toMatch(/isFinalOrCancelledOmsOrder/);
    expect(WMS_SYNC_SRC).toMatch(/cancelExistingWmsOrderForFinalOmsOrder/);
    expect(WMS_SYNC_SRC).toMatch(/skipped WMS sync/);
  });

  it("creates a new shipment when missing shippable lines have no planned shipment", () => {
    expect(WMS_SYNC_SRC).toMatch(/const orphanItemResult = await db\.execute/);
    expect(WMS_SYNC_SRC).toMatch(/const shippableShipmentItems = \(orphanItemResult\.rows/);
    expect(WMS_SYNC_SRC).toMatch(/if \(updatedShipments === 0\)/);
    expect(WMS_SYNC_SRC).toMatch(/createShipmentForOrder\(/);
    expect(WMS_SYNC_SRC).toMatch(/WMS line reconciliation created shipment for added order item/);
  });

  it("repairs existing pending WMS items that are not on an active shipment", () => {
    expect(WMS_SYNC_SRC).toMatch(/WITH active_shipment_qty AS/);
    expect(WMS_SYNC_SRC).toMatch(/FROM wms\.order_items oi/);
    expect(WMS_SYNC_SRC).toMatch(/os\.status NOT IN \('voided', 'cancelled'\)/);
    expect(WMS_SYNC_SRC).toMatch(/COALESCE\(asq\.qty, 0\)/);
    expect(WMS_SYNC_SRC).not.toMatch(/if \(missingLines\.length === 0\) return/);
  });

  it("does not regenerate shipment work for an already shipped OMS order with no open shippable demand", () => {
    expect(WMS_SYNC_SRC).toMatch(/hasOpenShippableOmsDemand/);
    expect(WMS_SYNC_SRC).toMatch(/wmsOrderState\?\.warehouseStatus === "shipped"/);
    expect(WMS_SYNC_SRC).toMatch(/!this\.hasOpenShippableOmsDemand\(omsLines\)/);
    expect(WMS_SYNC_SRC).toMatch(/return \{ insertedItems: 0, updatedShipments: 0 \}/);
  });

  it("prefers non-cancelled duplicate WMS rows when choosing the OMS-linked row", () => {
    expect(WMS_SYNC_SRC).toMatch(/CASE[\s\S]*WHEN \$\{wmsOrders\.warehouseStatus\} = 'cancelled' THEN 2/);
    expect(WMS_SYNC_SRC).toMatch(/WHEN \$\{wmsOrders\.warehouseStatus\} = 'shipped' THEN 1/);
  });

  it("reopens WMS work when reconciliation adds shippable demand", () => {
    expect(WMS_SYNC_SRC).toMatch(/UPDATE wms\.orders[\s\S]*THEN 'ready'/);
    expect(WMS_SYNC_SRC).toMatch(/ELSE w\.warehouse_status/);
  });

  it("recomputes WMS aggregate counts after reconciliation changes order items", () => {
    expect(WMS_SYNC_SRC).toMatch(/item_count = agg\.item_count/);
    expect(WMS_SYNC_SRC).toMatch(/unit_count = agg\.unit_count/);
    expect(WMS_SYNC_SRC).toMatch(/picked_count = agg\.picked_count/);
    expect(WMS_SYNC_SRC).toMatch(/COUNT\(\*\)::int AS item_count/);
    expect(WMS_SYNC_SRC).toMatch(/COALESCE\(SUM\(quantity\), 0\)::int AS unit_count/);
  });

  it("refreshes aggregate counts even when no new shipment item is needed", () => {
    expect(WMS_SYNC_SRC).toMatch(/if \(shippableShipmentItems\.length === 0\)[\s\S]*return \{ insertedItems: insertedItems\.length, updatedShipments: 0 \};/);
    expect(WMS_SYNC_SRC).toMatch(/UPDATE wms\.orders w[\s\S]*if \(shippableShipmentItems\.length === 0\)/);
  });

  it("refreshes existing WMS item pricing from OMS lines before ShipStation push", () => {
    expect(WMS_SYNC_SRC).toMatch(/UPDATE wms\.order_items oi/);
    expect(WMS_SYNC_SRC).toMatch(/unit_price_cents = COALESCE\(ol\.paid_price_cents, 0\)/);
    expect(WMS_SYNC_SRC).toMatch(/paid_price_cents = COALESCE\(ol\.paid_price_cents, 0\)/);
    expect(WMS_SYNC_SRC).toMatch(/total_price_cents = COALESCE\(ol\.total_price_cents, 0\)/);
    expect(WMS_SYNC_SRC).toMatch(/oi\.oms_order_line_id = ol\.id/);
    const orderItemsPriceUpdate = WMS_SYNC_SRC.match(/UPDATE wms\.order_items oi[\s\S]*?AND ol\.order_id = \$\{omsOrderId\}/)?.[0] ?? "";
    expect(orderItemsPriceUpdate).not.toContain("updated_at");
  });
});
