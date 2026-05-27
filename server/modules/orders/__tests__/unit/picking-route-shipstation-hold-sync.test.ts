import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PICKING_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../picking.routes.ts"),
  "utf8",
);

describe("picking routes ShipStation hold sync", () => {
  it("mirrors hold/release through WMS shipment-level ShipStation pointers", () => {
    expect(PICKING_ROUTES_SRC).toMatch(/syncWmsOrderShipStationHoldState\(id, "hold"\)/);
    expect(PICKING_ROUTES_SRC).toMatch(/syncWmsOrderShipStationHoldState\(id, "release"\)/);
    expect(PICKING_ROUTES_SRC).not.toMatch(/oms\.shipstation_order_id/);
  });
});
