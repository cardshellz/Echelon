import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PICKING_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../picking.routes.ts"),
  "utf8",
);

describe("picking routes ShipStation hold sync", () => {
  it("queues durable hold/release sync and mirrors through WMS shipment-level ShipStation pointers", () => {
    expect(PICKING_ROUTES_SRC).toMatch(/syncShipStationHoldNow/);
    expect(PICKING_ROUTES_SRC).toMatch(/providerHoldSync\.status === "pending" \? 202 : 200/);
    expect(PICKING_ROUTES_SRC).toMatch(/enqueueShipStationSortRankSyncRetry\(db, orderId, context\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/syncShipStationHoldNow\(id, "hold", "Hold"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/queueShipStationSortRankSync\(id, "HoldSortRank"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/syncShipStationHoldNow\(id, "release", "ReleaseHold"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/queueShipStationSortRankSync\(id, "ReleaseHoldSortRank"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/queueShipStationSortRankSync\(id, "PrioritySortRank"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/shippingEngine\.hold\(ref\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/shippingEngine\.releaseHold\(ref\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/engineRefFromRow/);
    expect(PICKING_ROUTES_SRC).not.toMatch(/oms\.shipstation_order_id/);
  });
});
