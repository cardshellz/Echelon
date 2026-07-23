import { describe, expect, it, vi } from "vitest";

import {
  EbayFulfillmentIngressPayloadError,
  mapEbayFulfillmentIngress,
} from "../../ebay-fulfillment-ingress.adapter";
import {
  mapShopifyFulfillmentCarrier,
  mapShopifyFulfillmentIngress,
  processShopifyFulfillmentIngress,
  ShopifyFulfillmentIngressPayloadError,
} from "../../shopify-fulfillment-ingress.adapter";

const shopifyMetadata = {
  sourceChannelId: 36,
  sourceEventId: "webhook-1",
  eventKind: "created" as const,
  source: "shopify_fulfillments_create",
};

describe("channel fulfillment ingress adapters", () => {
  it("normalizes decorated Shopify carrier names", () => {
    expect(mapShopifyFulfillmentCarrier("UPS\u00ae")).toBe("UPS");
    expect(mapShopifyFulfillmentCarrier("DHL\u2122 Express")).toBe("DHL");
  });

  it("normalizes REST and GraphQL Shopify resource ids to the same exact identity", () => {
    const rest = mapShopifyFulfillmentIngress({
      id: 6312306376863,
      order_id: 12148212400287,
      status: "success",
      tracking_number: "1ZTEST",
      tracking_company: "UPS",
      line_items: [{ id: 312147, quantity: 2 }],
    }, shopifyMetadata);
    const graphql = mapShopifyFulfillmentIngress({
      id: "gid://shopify/Fulfillment/6312306376863",
      order_id: "gid://shopify/Order/12148212400287",
      status: "success",
      tracking_number: "1ZTEST",
      tracking_company: "UPS",
      line_items: [{ id: "gid://shopify/LineItem/312147", quantity: 2 }],
    }, shopifyMetadata);

    expect(graphql).toMatchObject({
      sourceOrderId: rest?.sourceOrderId,
      sourceFulfillmentId: rest?.sourceFulfillmentId,
      lineItems: rest?.lineItems,
    });
  });

  it("acknowledges a non-success Shopify fulfillment without writing", async () => {
    const service = { process: vi.fn() };
    const outcome = await processShopifyFulfillmentIngress(service, {
      id: 6312306376863,
      order_id: 12148212400287,
      status: "cancelled",
      line_items: [{ id: 312147, quantity: 2 }],
    }, shopifyMetadata);

    expect(outcome).toEqual({ actionable: false, result: null });
    expect(service.process).not.toHaveBeenCalled();
  });

  it("rejects Shopify fulfillment data without exact channel line identity", () => {
    expect(() => mapShopifyFulfillmentIngress({
      id: 6312306376863,
      order_id: 12148212400287,
      status: "success",
      line_items: [{ sku: "EG-SLV-STD-P100", quantity: 1 }],
    }, shopifyMetadata)).toThrow(ShopifyFulfillmentIngressPayloadError);
  });

  it("maps every eBay package line by its exact line item id", () => {
    const input = mapEbayFulfillmentIngress({
      fulfillmentId: "9400150206217777402897",
      shippedDate: "2026-07-14T15:54:02.000Z",
      shippingCarrierCode: "USPS",
      shipmentTrackingNumber: "9400150206217777402897",
      lineItems: [
        { lineItemId: "10087108468621", quantity: 1 },
        { lineItemId: "10087108468622", quantity: 2 },
      ],
    }, {
      sourceChannelId: 67,
      sourceOrderId: "07-14878-86923",
      sourceEventId: "ebay-reconcile-1",
      source: "ebay_fulfillment_reconcile",
    });

    expect(input.lineItems).toEqual([
      { channelOrderLineId: "10087108468621", sourceFulfillmentLineId: "10087108468621", quantity: 1 },
      { channelOrderLineId: "10087108468622", sourceFulfillmentLineId: "10087108468622", quantity: 2 },
    ]);
  });

  it("rejects eBay package data without exact channel line identity", () => {
    expect(() => mapEbayFulfillmentIngress({
      fulfillmentId: "tracking-only",
      lineItems: [{ sku: "EG-SLV-STD-P100", quantity: 1 }],
    }, {
      sourceChannelId: 67,
      sourceOrderId: "07-14878-86923",
      sourceEventId: null,
      source: "ebay_fulfillment_reconcile",
    })).toThrow(EbayFulfillmentIngressPayloadError);
  });
});
