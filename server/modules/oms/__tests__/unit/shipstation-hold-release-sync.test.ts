import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHIPSTATION_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../shipstation.service.ts"),
  "utf8",
);
const WEBHOOK_RETRY_WORKER_SRC = readFileSync(
  resolve(__dirname, "../../webhook-retry.worker.ts"),
  "utf8",
);

describe("ShipStation WMS hold/release sync", () => {
  it("makes restorefromhold the final ShipStation write for release", () => {
    const syncStart = SHIPSTATION_SERVICE_SRC.indexOf("async function syncWmsOrderShipStationHoldState");
    const syncEnd = SHIPSTATION_SERVICE_SRC.indexOf("return { touched };", syncStart);
    const syncSection = SHIPSTATION_SERVICE_SRC.slice(syncStart, syncEnd);

    expect(syncSection).toMatch(/if \(mode === "release"\)/);
    expect(syncSection).toMatch(/releaseOrderFromHold\(ssOrderId\)/);
    expect(syncSection.indexOf("updateSortRankForShipmentRowsBestEffort")).toBeLessThan(
      syncSection.indexOf("releaseOrderFromHold(ssOrderId)"),
    );
  });

  it("does not block hold or release when the custom-field refresh fails", () => {
    expect(SHIPSTATION_SERVICE_SRC).toMatch(/async function updateSortRankForShipmentRowsBestEffort/);
    expect(SHIPSTATION_SERVICE_SRC).toMatch(/catch \(err: any\)[\s\S]*sort-rank refresh failed/);
  });

  it("routes hold sync through a durable retry topic that reads current WMS state", () => {
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/enqueueShipStationHoldSyncRetry/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/topic: "shipstation_hold_sync"/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/dispatchShipStationHoldSyncRetry/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/FROM wms\.orders/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/Number\(orderRow\.on_hold\) === 1 \? "hold" : "release"/);
  });
});
