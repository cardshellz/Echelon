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
    expect(WMS_SYNC_SRC).toMatch(/db\.insert\(outboundShipmentItems\)\.values/);
    expect(WMS_SYNC_SRC).toMatch(/enqueueShipStationShipmentPushRetry/);
  });
});
