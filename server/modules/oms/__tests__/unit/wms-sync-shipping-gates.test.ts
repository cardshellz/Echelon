import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("wms-sync.service :: shippable item gates", () => {
  it("does not create or push ShipStation shipments for digital-only OMS orders", () => {
    expect(WMS_SYNC_SRC).toMatch(/const txHasShippableItems = remainingOmsLines\.some\(\(line\) => line\.requiresShipping !== false\)/);
    expect(WMS_SYNC_SRC).toMatch(/if \(txHasShippableItems\)/);
  });

  it("only includes shippable lines in outbound shipment item inputs", () => {
    expect(WMS_SYNC_SRC).toMatch(/const shipmentItemInputs = remainingOmsLines\s+\.filter\(\(line\) => line\.requiresShipping !== false\)/);
    expect(WMS_SYNC_SRC).toMatch(/requiresShipping: wmsOrderItems\.requiresShipping/);
    expect(WMS_SYNC_SRC).toMatch(/\.filter\(\(i: any\) => i\.requiresShipping !== 0\)/);
  });

  it("persists the ShipStation handoff command inside the WMS create transaction", () => {
    expect(WMS_SYNC_SRC).toMatch(
      /await enqueueShipStationShipmentPushRetry\(\s*tx,\s*shipmentIdForPush,\s*"initial shipping-engine handoff",\s*\)/,
    );
    const enqueueIndex = WMS_SYNC_SRC.search(
      /await enqueueShipStationShipmentPushRetry\(\s*tx,\s*shipmentIdForPush,\s*"initial shipping-engine handoff"/,
    );
    const transactionReturnIndex = WMS_SYNC_SRC.indexOf(
      "return { newWmsOrder, shipmentIdForPush",
    );
    expect(enqueueIndex).toBeGreaterThan(0);
    expect(transactionReturnIndex).toBeGreaterThan(enqueueIndex);
  });
});
