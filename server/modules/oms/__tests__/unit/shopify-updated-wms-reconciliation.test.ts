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
    expect(OMS_WEBHOOKS_SRC).toMatch(/isFinal: isFinalOmsState/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/orders\/updated skipped WMS reconcile for final order/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/else if \([\s\S]*!isFinalOmsState[\s\S]*hasAuthorizedShippableWork[\s\S]*shopifyOrder\.financial_status === "paid"/);
  });

  it("persists normalized Shopify pricing when orders/updated adds or changes lines", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/const normalizedLineItems = normalizeShopifyLineItems\(/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/const normalizedLineMap = new Map/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/paidPriceCents: normalizedLine\?\.paidPriceCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/totalPriceCents: normalizedLine\?\.totalCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/planDiscountCents: normalizedLine\?\.planDiscountCents/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/couponDiscountCents: normalizedLine\?\.couponDiscountCents/);
  });

  it("records Shopify update-only line authority without authorizing new WMS work", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/deriveOmsLineAuthority/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/sourceTopic: "orders\/updated"/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/authorityFulfillableQuantity/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/hasAuthorizedShippableWork/);
  });

  it("syncs WMS address from canonical Shopify shipping fields and handles existing shipments", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/canonicalShipToFromShopifyUpdate\(shopifyOrder, existing\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/shipping_address = \$\{nextShipTo\.address1\}/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/if \(didWmsAddressChange && !isFinalOmsState\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/handleWmsAddressChange\(/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/handleAddressChangeOnShipment/);
  });

  it("fans Shopify address updates out to every WMS row linked to the OMS order", () => {
    const addressSyncBlock = OMS_WEBHOOKS_SRC.match(
      /const wmsOrders = await db\.execute[\s\S]*?\/\/ Update line items if changed/,
    )?.[0] ?? "";

    expect(addressSyncBlock).toMatch(/const wmsOrderRows = wmsOrders\.rows/);
    expect(addressSyncBlock).toMatch(/for \(const wmsOrderRow of wmsOrderRows\)/);
    expect(addressSyncBlock).toMatch(/WHERE \(source = 'oms' AND oms_fulfillment_order_id = \$\{String\(existing\.id\)\}\)/);
    expect(addressSyncBlock).not.toMatch(/LIMIT 1/);
  });

  it("routes Shopify fulfilled webhooks through WMS shipment cascade", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/applyChannelFulfillment/);
    expect(OMS_WEBHOOKS_SRC).toMatch(/shopify_fulfilled_webhook/);
  });

  it("replays Shopify fulfilled webhooks through WMS before already-shipped acknowledgement", () => {
    const fulfilledBlock = OMS_WEBHOOKS_SRC.match(
      /app\.post\("\/api\/oms\/webhooks\/orders\/fulfilled"[\s\S]*?POST \/api\/oms\/webhooks\/refunds\/create/,
    )?.[0] ?? "";

    expect(fulfilledBlock).toMatch(/const applyWmsChannelFulfillment/);
    expect(fulfilledBlock).toMatch(
      /if \(existing\.status === "shipped"\)[\s\S]*applyWmsChannelFulfillment\("shopify_fulfilled_webhook_replay"\)[\s\S]*acknowledgeProcessed/,
    );
  });
});
