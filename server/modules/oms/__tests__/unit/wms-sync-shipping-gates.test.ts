import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WMS_SYNC_SRC = readFileSync(
  resolve(__dirname, "../../wms-sync.service.ts"),
  "utf-8",
);

describe("wms-sync.service :: shippable item gates", () => {
  it("does not create or push ShipStation shipments for digital-only OMS orders", () => {
    expect(WMS_SYNC_SRC).toMatch(/const hasShippableItems = omsLines\.some\(line => line\.requiresShipping !== false\)/);
    expect(WMS_SYNC_SRC).toMatch(/if \(hasShippableItems\)/);
  });

  it("only includes shippable lines in outbound shipment item inputs", () => {
    expect(WMS_SYNC_SRC).toMatch(/const shipmentItemInputs = omsLines\s+\.filter\(\(line\) => line\.requiresShipping !== false\)/);
    expect(WMS_SYNC_SRC).toMatch(/requiresShipping: wmsOrderItems\.requiresShipping/);
    expect(WMS_SYNC_SRC).toMatch(/\.filter\(\(i: any\) => i\.requiresShipping !== 0\)/);
  });
});
