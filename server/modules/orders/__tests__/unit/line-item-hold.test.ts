import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_SRC = readFileSync(resolve(__dirname, "../../picking.routes.ts"), "utf8");
const STORAGE_SRC = readFileSync(resolve(__dirname, "../../orders.storage.ts"), "utf8");
const SPLIT_SRC = readFileSync(resolve(__dirname, "../../../wms/line-item-hold.ts"), "utf8");
const SHIPSTATION_SRC = readFileSync(resolve(__dirname, "../../../oms/shipstation.service.ts"), "utf8");
const PICKING_SRC = readFileSync(resolve(__dirname, "../../picking.use-cases.ts"), "utf8");
const FLOW_WATERFALL_SRC = readFileSync(resolve(__dirname, "../../../oms/flow-waterfall.service.ts"), "utf8");
const OPS_HEALTH_SRC = readFileSync(resolve(__dirname, "../../../oms/ops-health.service.ts"), "utf8");
const RECON_SRC = readFileSync(resolve(__dirname, "../../../oms/oms-flow-reconciliation.service.ts"), "utf8");
const OMS_ORDERS_SRC = readFileSync(resolve(__dirname, "../../../../../client/src/pages/OmsOrders.tsx"), "utf8");

// Line-item hold, Phase 1 (LINE-ITEM-HOLD-DESIGN.md): a lead/admin can hold a
// single pre-order line so the rest of the order ships. P1 records the hold +
// reason and gates the action by role; the shipping behaviour is P2.
describe("line-item hold (P1)", () => {
  it("exposes per-line hold + release endpoints gated by the orders:hold permission", () => {
    expect(ROUTES_SRC).toMatch(/\/api\/orders\/:id\/items\/:itemId\/hold/);
    expect(ROUTES_SRC).toMatch(/\/api\/orders\/:id\/items\/:itemId\/release-hold/);
    // Both endpoints must carry the orders:hold gate so pickers (whose role
    // lacks it) cannot hold or release lines.
    const gates = ROUTES_SRC.match(/requirePermission\("orders",\s*"hold"\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to hold a line that has already started picking or fulfillment", () => {
    expect(ROUTES_SRC).toMatch(/item\.status !== "pending"/);
    expect(ROUTES_SRC).toMatch(/pickedQuantity \?\? 0\) > 0/);
    expect(ROUTES_SRC).toMatch(/fulfilledQuantity \?\? 0\) > 0/);
  });

  it("storage sets the per-line on_hold flag + reason on hold and clears them on release", () => {
    expect(STORAGE_SRC).toMatch(/holdOrderItem\(itemId: number, reason: string\)/);
    expect(STORAGE_SRC).toMatch(/onHold: true, holdReason: reason\.slice\(0, 200\)/);
    expect(STORAGE_SRC).toMatch(/releaseOrderItem\(itemId: number\)/);
    expect(STORAGE_SRC).toMatch(/onHold: false, holdReason: null/);
  });

  it("returns the per-line hold state to the order API so the UI can render it", () => {
    expect(STORAGE_SRC).toMatch(/onHold: row\.on_hold/);
    expect(STORAGE_SRC).toMatch(/holdReason: row\.hold_reason/);
  });
});

// P2a: a held line is pulled from shipping — it moves into its own held shipment
// that ShipStation push refuses, while the main shipment ships without it.
describe("line-item hold (P2a — held line does not ship)", () => {
  it("pushShipment refuses a held shipment (single chokepoint for every push path)", () => {
    expect(SHIPSTATION_SRC).toMatch(/shipmentRow\.held === true/);
    expect(SHIPSTATION_SRC).toMatch(/field: "shipment\.held"/);
    expect(SHIPSTATION_SRC).toMatch(/held: outboundShipments\.held/);
  });

  it("hold splits the line into its OWN held shipment and moves the item, in one transaction", () => {
    expect(SPLIT_SRC).toMatch(/db\.transaction/);
    expect(SPLIT_SRC).toMatch(/INSERT INTO\s+wms\.outbound_shipments[\s\S]*held, held_at, on_hold_reason/);
    expect(SPLIT_SRC).toMatch(/true, \$\{args\.now\}/);
    expect(SPLIT_SRC).toMatch(/UPDATE wms\.outbound_shipment_items SET shipment_id = \$\{heldShipmentId\}/);
  });

  it("hold re-pushes the main shipment (without the held line) only if it was already in ShipStation", () => {
    expect(ROUTES_SRC).toMatch(/holdLineItemWithSplit/);
    expect(ROUTES_SRC).toMatch(/split\.mainShipmentPushed && split\.mainStillHasItems/);
    expect(ROUTES_SRC).toMatch(/enqueueShipStationShipmentPushRetry\(db, split\.mainShipmentId/);
  });

  it("release un-holds the shipment so the line ships on its own", () => {
    expect(SPLIT_SRC).toMatch(/releaseLineItemFromHold/);
    expect(SPLIT_SRC).toMatch(/SET held = false, held_at = NULL/);
    expect(ROUTES_SRC).toMatch(/enqueueShipStationShipmentPushRetry\(db, released\.heldShipmentId/);
  });
});

// P2a fix (migration 123): holdLineItemWithSplit creates a SECOND active shipment
// (source='line_item_hold') for the order. The uq_outbound_shipments_active_per_order
// partial index must EXCLUDE that source or the INSERT violates the "one active
// shipment per order" invariant and the hold endpoint 500s (verified against the real
// schema on a live order). This guards the exclusion from being dropped if the index
// is ever recreated.
describe("line-item hold (P2a fix — held shipment excluded from active-per-order invariant)", () => {
  const MIGRATION = readFileSync(
    resolve(__dirname, "../../../../../migrations/123_line_item_hold_active_shipment_index.sql"),
    "utf8",
  );
  it("migration 123 recreates the active-per-order index excluding line_item_hold", () => {
    expect(MIGRATION).toMatch(/DROP INDEX IF EXISTS wms\.uq_outbound_shipments_active_per_order/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX uq_outbound_shipments_active_per_order/);
    expect(MIGRATION).toMatch(/'line_item_hold'/);
    // the pre-existing combined/split child exclusions must be preserved.
    expect(MIGRATION).toMatch(/echelon_combined_child/);
    expect(MIGRATION).toMatch(/shipstation_combined_child/);
    expect(MIGRATION).toMatch(/shipstation_split/);
  });
});

// P2b: held shipments/lines must not look like stuck work or block the rest.
describe("line-item hold (P2b — held-aware readers)", () => {
  it("the ready-to-ship gate ignores held lines (so the rest of the order can ship)", () => {
    expect(PICKING_SRC).toMatch(/requiresShipping === 1 && !item\.onHold/);
  });

  it("a held line cannot be picked", () => {
    expect(PICKING_SRC).toMatch(/beforeItem\.onHold && status !== "pending"/);
    expect(PICKING_SRC).toMatch(/on hold and cannot be picked/);
  });

  it("the 'not pushed to ShipStation' detectors all skip held shipments", () => {
    expect(FLOW_WATERFALL_SRC).toMatch(/COALESCE\(os\.held, false\) = false/);
    expect(OPS_HEALTH_SRC).toMatch(/COALESCE\(os\.held, false\) = false/);
    expect(RECON_SRC).toMatch(/COALESCE\(os\.held, false\) = false/);
  });
});

// P5 (LINE-ITEM-HOLD-DESIGN.md §6.8/§7): ops surfaces held-line aging + the
// whole-order all-held exception. Crucially, the generic "shipment on hold"
// review warning must STOP counting expected pre-order line holds (which also
// set held=true), or every hold trips a false "needs warehouse-ops review".
describe("line-item hold (P5 — ops aging + all-held exception)", () => {
  it("the SHIPMENT_ON_HOLD review warning excludes pre-order line holds", () => {
    // both the count and sample queries must exclude source='line_item_hold'
    const exclusions = OPS_HEALTH_SRC.match(/COALESCE\(source, ''\)\s*<>\s*'line_item_hold'/g) ?? [];
    expect(exclusions.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes a LINE_HELD_AGING detector keyed on line-item holds past a day threshold", () => {
    expect(OPS_HEALTH_SRC).toMatch(/const HELD_LINE_AGING_DAYS = \d+/);
    expect(OPS_HEALTH_SRC).toMatch(/code: "LINE_HELD_AGING"/);
    expect(OPS_HEALTH_SRC).toMatch(/os\.source = 'line_item_hold'/);
    expect(OPS_HEALTH_SRC).toMatch(
      /held_at < NOW\(\) - \(\$\{HELD_LINE_AGING_DAYS\} \* INTERVAL '1 day'\)/,
    );
  });

  it("exposes an ORDER_ALL_LINES_HELD exception (every shippable line held, nothing shipped)", () => {
    expect(OPS_HEALTH_SRC).toMatch(/code: "ORDER_ALL_LINES_HELD"/);
    expect(OPS_HEALTH_SRC).toMatch(/BOOL_OR\(COALESCE\(oi\.on_hold, false\)\) = true/);
    expect(OPS_HEALTH_SRC).toMatch(/SUM\(COALESCE\(oi\.fulfilled_quantity, 0\)\) = 0/);
    // and no remaining open shippable non-held line
    expect(OPS_HEALTH_SRC).toMatch(/COALESCE\(oi\.on_hold, false\) = false\s*\)\s*= 0/);
  });

  it("the ops UI renders dedicated cards for the two new held exceptions", () => {
    expect(OMS_ORDERS_SRC).toMatch(/issue\.code === "LINE_HELD_AGING"/);
    expect(OMS_ORDERS_SRC).toMatch(/issue\.code === "ORDER_ALL_LINES_HELD"/);
  });
});
