import { describe, expect, it } from "vitest";
import {
  CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX,
  CHANNEL_FULFILLMENT_REPAIR_SOURCES,
  resolveNewChannelFulfillmentNotifyCustomer,
  resolvePersistedChannelFulfillmentNotifyCustomer,
} from "../../channel-fulfillment-notification.policy";

const repairSources = [
  ...Object.values(CHANNEL_FULFILLMENT_REPAIR_SOURCES),
  `${CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX}SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED`,
];

describe("channel fulfillment notification provenance", () => {
  it.each(repairSources)("creates silent Shopify repairs for %s without changing eBay", source => {
    expect(resolveNewChannelFulfillmentNotifyCustomer("shopify", source, undefined)).toBe(false);
    expect(resolveNewChannelFulfillmentNotifyCustomer("shopify", source, false)).toBe(false);
    expect(resolveNewChannelFulfillmentNotifyCustomer("ebay", source, undefined)).toBe(true);
    expect(resolvePersistedChannelFulfillmentNotifyCustomer("ebay", source, true)).toBe(true);
    expect(resolvePersistedChannelFulfillmentNotifyCustomer("shopify", source, false)).toBe(false);
  });

  it.each(repairSources)("holds old notification-enabled repair requests for %s", source => {
    for (const value of [undefined, true]) {
      expect(() => resolvePersistedChannelFulfillmentNotifyCustomer("shopify", source, value))
        .toThrowError(expect.objectContaining({ code: "SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED" }));
    }
    expect(() => resolveNewChannelFulfillmentNotifyCustomer("shopify", source, true))
      .toThrowError(expect.objectContaining({ code: "SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED" }));
  });

  it.each([undefined, "live_shipping_event", "legacy_shopify_fulfillment_retry", "legacy_delayed_tracking_retry",
    "script:backfill-channel-fulfillment-authority"])("preserves the normal/default or explicit choice for %s", source => {
    for (const value of [undefined, true, false]) {
      expect(resolveNewChannelFulfillmentNotifyCustomer("shopify", source, value)).toBe(value ?? true);
      expect(resolvePersistedChannelFulfillmentNotifyCustomer("shopify", source, value)).toBe(value ?? true);
    }
  });

  it.each([null, "false", 0, {}, []])("rejects malformed settings before any fallback: %j", value => {
    for (const source of [undefined, ...repairSources]) {
      expect(() => resolveNewChannelFulfillmentNotifyCustomer("shopify", source, value))
        .toThrowError(expect.objectContaining({ code: "INVALID_CHANNEL_FULFILLMENT_NOTIFICATION_POLICY" }));
      expect(() => resolvePersistedChannelFulfillmentNotifyCustomer("shopify", source, value))
        .toThrowError(expect.objectContaining({ code: "INVALID_CHANNEL_FULFILLMENT_NOTIFICATION_POLICY" }));
    }
  });
});
