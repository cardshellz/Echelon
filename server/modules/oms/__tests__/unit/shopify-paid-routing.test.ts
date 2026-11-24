import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../application/oms-webhooks.ts"),
  "utf-8",
);
const INGEST_AND_ROUTE_SRC = readFileSync(
  resolve(__dirname, "../../application/channel-order-ingest-and-route.ts"),
  "utf-8",
);

describe("oms-webhooks :: Shopify paid routing", () => {
  it("does not skip routing for an existing paid order", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("alwaysSyncExistingAssigned: true");
    expect(INGEST_AND_ROUTE_SRC).toMatch(
      /already exists in OMS \(id=\$\{omsOrder\.id\}\), ensuring routing/,
    );
    expect(OMS_WEBHOOKS_SRC).not.toMatch(
      /already exists in OMS \(id=\$\{omsOrder\.id\}\), skipping[\s\S]{0,300}return;/,
    );
  });

  it("finishes reservation and warehouse assignment when the existing order is unrouted", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("const outcome = await ingestAndRoute({");
    expect(INGEST_AND_ROUTE_SRC).toMatch(
      /if \(!omsOrder\.warehouseId\) \{[\s\S]*await input\.omsService\.reserveInventory\(omsOrder\.id\);[\s\S]*await input\.omsService\.assignWarehouse\(omsOrder\.id\);/,
    );
    expect(INGEST_AND_ROUTE_SRC).toMatch(
      /await ensureChannelOrderQueuedForWmsSync\([\s\S]*if \(!omsOrder\.warehouseId\)[\s\S]*await ensureChannelOrderQueuedForWmsSync\(/,
    );
  });
});
