import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);

describe("oms-webhooks :: Shopify paid routing", () => {
  it("does not skip routing for an existing paid order", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/already exists in OMS \(id=\$\{omsOrder\.id\}\), ensuring routing/);
    expect(OMS_WEBHOOKS_SRC).not.toMatch(/already exists in OMS \(id=\$\{omsOrder\.id\}\), skipping[\s\S]{0,300}return;/);
  });

  it("finishes reservation and warehouse assignment when the existing order is unrouted", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/if \(!omsOrder\.warehouseId\) \{[\s\S]*await omsService\.reserveInventory\(omsOrder\.id\);[\s\S]*await omsService\.assignWarehouse\(omsOrder\.id\);/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/await ensureOmsOrderQueuedForWmsSync\([\s\S]*omsOrder\.id,[\s\S]*shopifyOrder\.name \|\| externalOrderId,[\s\S]*\);[\s\S]*if \(!omsOrder\.warehouseId\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/if \(!omsOrder\.warehouseId\)[\s\S]*await ensureOmsOrderQueuedForWmsSync\([\s\S]*omsOrder\.id,[\s\S]*shopifyOrder\.name \|\| externalOrderId,[\s\S]*\);/);
  });
});
