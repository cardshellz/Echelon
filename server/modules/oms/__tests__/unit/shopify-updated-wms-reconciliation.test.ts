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

  it("does not requeue WMS reconciliation after Shopify reports a final order", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/const isCancelledPayload = Boolean\(shopifyOrder\.cancelled_at\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/const isFinalOmsState =/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/orders\/updated skipped WMS reconcile for final order/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/else if \(!isFinalOmsState && \(shopifyOrder\.financial_status === "paid"/);
  });

  it("persists normalized Shopify pricing when orders/updated adds or changes lines", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/const normalizedLineItems = normalizeShopifyLineItems\(/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/const normalizedLineMap = new Map/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/paidPriceCents: normalizedLine\?\.paidPriceCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/totalPriceCents: normalizedLine\?\.totalCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/planDiscountCents: normalizedLine\?\.planDiscountCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/couponDiscountCents: normalizedLine\?\.couponDiscountCents/);
  });
});
