import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHIPSTATION_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../shipstation.service.ts"),
  "utf8",
);

const OMS_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../../../routes/oms.routes.ts"),
  "utf8",
);

const PRIORITY_BACKFILL_SRC = readFileSync(
  resolve(__dirname, "../../../../../scripts/backfill-priority-and-repush.ts"),
  "utf8",
);

const DEBUG_SS_PUSH_SRC = readFileSync(
  resolve(__dirname, "../../../../../scripts/debug-ss-push.ts"),
  "utf8",
);

describe("ShipStation legacy OMS push removal", () => {
  it("does not expose or implement the legacy OMS order push function", () => {
    const serviceReturnBlock = SHIPSTATION_SERVICE_SRC.slice(
      SHIPSTATION_SERVICE_SRC.lastIndexOf("return {"),
    );

    expect(SHIPSTATION_SERVICE_SRC).not.toMatch(/async function pushOrder/);
    expect(serviceReturnBlock).not.toMatch(/\bpushOrder,/);
  });

  it("keeps the manual OMS route shipment-backed", () => {
    expect(OMS_ROUTES_SRC).not.toMatch(/\.pushOrder\(/);
    expect(OMS_ROUTES_SRC).toMatch(/wms\.outbound_shipments/);
    expect(OMS_ROUTES_SRC).toMatch(/\.pushShipment\(/);
    expect(OMS_ROUTES_SRC).toMatch(/No pushable WMS shipment found for OMS order/);
  });

  it("does not let operational scripts repush through OMS order-level ShipStation state", () => {
    expect(PRIORITY_BACKFILL_SRC).not.toMatch(/pushOrder/);
    expect(PRIORITY_BACKFILL_SRC).not.toMatch(/oms\.shipstation_order_id/);
    expect(PRIORITY_BACKFILL_SRC).toMatch(/updateSortRank/);

    expect(DEBUG_SS_PUSH_SRC).not.toMatch(/pushOrder/);
    expect(DEBUG_SS_PUSH_SRC).toMatch(/pushShipment/);
    expect(DEBUG_SS_PUSH_SRC).toMatch(/wms\.outbound_shipments/);
  });
});
