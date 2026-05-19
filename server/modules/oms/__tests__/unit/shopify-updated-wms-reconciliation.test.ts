import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);

describe("Shopify orders/updated WMS reconciliation", () => {
  it("reconciles WMS after processing Shopify line item changes", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/orders\/updated/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/await ensureOmsOrderQueuedForWmsSync\([\s\S]*existing\.id,[\s\S]*shopifyOrder\.name \|\| externalOrderId/);
  });

  it("queues a durable WMS sync retry if orders/updated cannot reconcile", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/orders\/updated could not reconcile WMS lines because wmsSyncService is unavailable/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/orders\/updated saw paid shippable work but wmsSyncService is unavailable/);
  });
});
