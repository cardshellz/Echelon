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
const ORDER_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../../orders/orders.storage.ts"),
  "utf8",
);
const SERVER_INDEX_SRC = readFileSync(
  resolve(__dirname, "../../../..", "index.ts"),
  "utf8",
);
const PICK_PRIORITY_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../../..", "routes/pick-priority.routes.ts"),
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

  it("routes sort-rank refreshes through a durable retry topic", () => {
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/enqueueShipStationSortRankSyncRetry/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/topic: "shipstation_sort_rank_sync"/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/dispatchShipStationSortRankSyncRetry/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/updateSortRank\(wmsOrderId\)/);
  });

  it("queues ShipStation sync after startup sort-rank recompute changes active WMS rows", () => {
    expect(ORDER_STORAGE_SRC).toMatch(/export async function recomputeAllActiveSortRanksDetailed/);
    expect(ORDER_STORAGE_SRC).toMatch(/if \(row\.sortRank === rank && sameDateTime/);
    expect(SERVER_INDEX_SRC).toMatch(/recomputeAllActiveSortRanksDetailed/);
    expect(SERVER_INDEX_SRC).toMatch(
      /enqueueShipStationSortRankSyncRetry\(\s*db,\s*orderId,\s*"startup sort_rank recompute"/,
    );
  });

  it("queues ShipStation sync after pick-priority settings change active sort ranks", () => {
    expect(PICK_PRIORITY_ROUTES_SRC).toMatch(/recomputeAllActiveSortRanksDetailed/);
    expect(PICK_PRIORITY_ROUTES_SRC).toMatch(/enqueueShipStationSortRankSyncRetry/);
    expect(PICK_PRIORITY_ROUTES_SRC).toMatch(/pick-priority settings changed/);
    expect(PICK_PRIORITY_ROUTES_SRC).toMatch(/sortRankSync/);
  });
});
