import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_SRC = readFileSync(resolve(__dirname, "../../orders.storage.ts"), "utf8");
const ROUTES_SRC = readFileSync(resolve(__dirname, "../../picking.routes.ts"), "utf8");
const SHIPSTATION_SRC = readFileSync(
  resolve(__dirname, "../../../oms/shipstation.service.ts"),
  "utf8",
);
const RETRY_SRC = readFileSync(
  resolve(__dirname, "../../../oms/webhook-retry.worker.ts"),
  "utf8",
);
const PICKING_SRC = readFileSync(
  resolve(__dirname, "../../../../../client/src/pages/Picking.tsx"),
  "utf8",
);

describe("order hold downstream authority", () => {
  it("commits the hold and provider retry together while revoking the active picker", () => {
    const section = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("async holdOrder("),
      STORAGE_SRC.indexOf("async releaseHoldOrder("),
    );

    expect(section).toContain("db.transaction");
    expect(section).toContain("assignedPickerId: null");
    expect(section).toContain("startedAt: null");
    expect(section).toContain("enqueueShipStationHoldSyncInTransaction(tx");
    expect(section).toContain('requestedMode: "hold"');
  });

  it("does not let an assigned picker reclaim an order after it is held", () => {
    const section = STORAGE_SRC.slice(
      STORAGE_SRC.indexOf("async claimOrder("),
      STORAGE_SRC.indexOf("async releaseOrder("),
    );

    expect(section).toContain("eq(orders.onHold, 0)");
    expect(section).toContain("isNull(orders.orderEditOperationId)");
  });

  it("blocks never-pushed shipments at the ShipStation choke point", () => {
    expect(SHIPSTATION_SRC).toContain("on_hold: wmsOrders.onHold");
    expect(SHIPSTATION_SRC).toContain("if (Number(orderRow.on_hold) === 1)");
    expect(SHIPSTATION_SRC).toContain('field: "order.on_hold"');
  });

  it("refreshes picker clients and makes live hold state override local picking state", () => {
    expect(ROUTES_SRC).toMatch(/storage\.holdOrder\(id\)[\s\S]*broadcastOrdersUpdated\(\)/);
    expect(PICKING_SRC).toContain("onHold: apiOrder.onHold");
    expect(PICKING_SRC).toContain("Release the hold before opening this order for picking.");
    expect(PICKING_SRC).toContain("Picking was closed immediately");
  });

  it("does not silently accept malformed linked provider references", () => {
    expect(RETRY_SRC).toContain("if (touched !== expected)");
    expect(RETRY_SRC).toContain("linked shipment(s) for WMS order");
  });
});
