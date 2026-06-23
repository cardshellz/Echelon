import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_SRC = readFileSync(resolve(__dirname, "../../picking.routes.ts"), "utf8");
const STORAGE_SRC = readFileSync(resolve(__dirname, "../../orders.storage.ts"), "utf8");
const SPLIT_SRC = readFileSync(resolve(__dirname, "../../../wms/line-item-hold.ts"), "utf8");
const SHIPSTATION_SRC = readFileSync(resolve(__dirname, "../../../oms/shipstation.service.ts"), "utf8");

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
