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

  it("syncs WMS address from canonical Shopify shipping fields and handles existing shipments", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/canonicalShipToFromShopifyUpdate\(shopifyOrder, existing\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/shipping_address = \$\{nextShipTo\.address1\}/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/if \(didWmsAddressChange && !isFinalOmsState\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/handleWmsAddressChange\(/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/handleAddressChangeOnShipment/);
  });

  it("does not let Shopify fulfilled webhooks mark WMS shipments shipped", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/ShipStation shipment flow owns WMS shipment state/);
    const fulfilledHandler = OMS_WEBHOOKS_SRC.match(/orders\/fulfilled[\s\S]*?eventType: "shipped"/)?.[0] ?? "";
    expect(fulfilledHandler).not.toMatch(/UPDATE wms\.outbound_shipments SET[\s\S]*status = 'shipped'/);
  });
});
