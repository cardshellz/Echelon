import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function sourceBlock(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length;
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

const EBAY_INGESTION_SRC = readSource("../../ebay-order-ingestion.ts");
const EBAY_RECONCILER_SRC = readSource("../../reconcilers/ebay.reconciler.ts");
const FULFILLMENT_PUSH_SRC = readSource("../../fulfillment-push.service.ts");
const WEBHOOK_RETRY_SRC = readSource("../../webhook-retry.worker.ts");
const WMS_SYNC_SRC = readSource("../../wms-sync.service.ts");

const EBAY_ROUTING_TEST_SRC = readSource("ebay-routing.test.ts");
const EBAY_FULFILLMENT_RECONCILER_TEST_SRC = readSource(
  "ebay-fulfillment-reconciler.test.ts",
);
const EBAY_TRACKING_PUSH_TEST_SRC = readSource("ebay-tracking-push-regression.test.ts");
const SHIP_NOTIFY_RETRY_TEST_SRC = readSource("ship-notify-retry.test.ts");
const C2_TX_AWARE_PIPELINE_TEST_SRC = readSource("c2-tx-aware-pipeline.test.ts");

describe("OMS/WMS authority conformance :: eBay and WMS sync retries", () => {
  it("keeps WMS sync retries durable after eBay ingest and partial sync failures", () => {
    const ensureEbaySyncBlock = sourceBlock(
      EBAY_INGESTION_SRC,
      "async function ensureEbayOrderQueuedForWmsSync",
      "function dollarsToCents",
    );
    const retryEnqueueBlock = sourceBlock(
      WEBHOOK_RETRY_SRC,
      "export async function enqueueOmsWmsSyncRetry",
      "export async function enqueueWmsShipmentCreateRetry",
    );
    const retryDispatchBlock = sourceBlock(
      WEBHOOK_RETRY_SRC,
      "export async function dispatchOmsWmsSyncRetry",
      "export async function dispatchWmsShipmentCreateRetry",
    );

    expect(EBAY_ROUTING_TEST_SRC).toContain(
      "re-queues on a genuine WMS sync failure, but treats an intentional skip as a no-op",
    );
    expect(SHIP_NOTIFY_RETRY_TEST_SRC).toContain('describe("enqueueOmsWmsSyncRetry"');
    expect(SHIP_NOTIFY_RETRY_TEST_SRC).toContain('describe("dispatchOmsWmsSyncRetry"');
    expect(SHIP_NOTIFY_RETRY_TEST_SRC).toContain(
      "retries (does not succeed) when syncOmsOrderToWms throws a genuine error",
    );
    expect(C2_TX_AWARE_PIPELINE_TEST_SRC).toContain(
      "syncOmsOrderToWms runs reservation OUTSIDE the create transaction",
    );
    expect(WMS_SYNC_SRC).toContain("Reservation partial failure after promotion");
    expect(WMS_SYNC_SRC).toContain("Inventory reservation partial failure");
    expect(ensureEbaySyncBlock).toContain("enqueueOmsWmsSyncRetry(db, omsOrderId, err)");
    expect(ensureEbaySyncBlock).toContain("sync intentionally skipped");
    expect(retryEnqueueBlock).toContain('topic: "oms_wms_sync"');
    expect(retryEnqueueBlock).toContain("payload: { omsOrderId }");
    expect(retryDispatchBlock).toContain("wmsSync.syncOmsOrderToWms(omsOrderId)");
    expect(retryDispatchBlock).toContain("markRowSuccess");
    expect(retryDispatchBlock).toContain("recordRetryFailure");
  });

  it("maps eBay ingest into OMS line authority and final commercial states", () => {
    const mapBlock = sourceBlock(
      EBAY_INGESTION_SRC,
      "function mapEbayOrderToOrderData",
      "let pollInterval",
    );

    expect(mapBlock).toContain('sourceTopic: "ebay/order"');
    expect(mapBlock).toContain('ebayOrder.orderPaymentStatus === "PENDING"');
    expect(mapBlock).toContain('ebayOrder.orderPaymentStatus === "FAILED"');
    expect(mapBlock).toContain('ebayOrder.orderPaymentStatus === "FULLY_REFUNDED"');
    expect(mapBlock).toContain('ebayOrder.orderPaymentStatus === "PARTIALLY_REFUNDED"');
    expect(mapBlock).toContain('ebayOrder.cancelStatus?.cancelState === "CANCELED"');
    expect(mapBlock).toContain('status = "cancelled"');
    expect(mapBlock).toContain('financialStatus = "refunded"');
    expect(mapBlock).toContain('financialStatus = "partially_refunded"');
    expect(mapBlock).toContain("channelShipByDate");
    expect(mapBlock).toContain("externalLineItemId: item.lineItemId");
    expect(mapBlock).toContain('fulfillmentProvider: "ebay"');
    expect(mapBlock).toContain("paidPriceCents");
  });

  it("keeps eBay poll, webhook, and reingest paths routed into OMS to WMS sync", () => {
    expect(EBAY_ROUTING_TEST_SRC).toContain(
      "routes existing orders that do not have warehouse assignment yet",
    );
    expect(EBAY_INGESTION_SRC).toContain(
      "await omsService.ingestOrder(EBAY_CHANNEL_ID, ebayOrder.orderId, orderData)",
    );
    expect(EBAY_INGESTION_SRC).toContain(
      "await omsService.ingestOrder(EBAY_CHANNEL_ID, orderId, orderData)",
    );
    expect(EBAY_INGESTION_SRC).toContain(
      "await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, ebayOrder.orderId)",
    );
    expect(EBAY_INGESTION_SRC).toContain(
      "await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, orderId)",
    );
    expect(EBAY_INGESTION_SRC).toContain("recordWebhookReceived");
    expect(EBAY_INGESTION_SRC).toContain("markWebhookSucceeded");
    expect(EBAY_INGESTION_SRC).toContain("markWebhookFailed");
  });

  it("carries eBay cancellations through OMS and WMS without rematerializing work", () => {
    const pollBlock = sourceBlock(
      EBAY_INGESTION_SRC,
      "export async function pollEbayOrders",
      "export function createEbayOrderWebhookHandler",
    );

    expect(pollBlock).toContain('orderData.status === "cancelled"');
    expect(pollBlock).toContain("UPDATE oms_orders SET status = 'cancelled'");
    expect(pollBlock).toContain("cancelWmsOrder");
    expect(pollBlock).toContain('"ebay_cancel"');
    expect(pollBlock).toContain("Failed to cancel WMS order");
    expect(WMS_SYNC_SRC).toContain("isFinalOrCancelledOmsOrder");
    expect(WMS_SYNC_SRC).toContain("cancelExistingWmsOrderForFinalOmsOrder");
    expect(WMS_SYNC_SRC).toContain("skipped WMS sync");
  });

  it("keeps eBay tracking push shipment-scoped, idempotent, and retry-backed", () => {
    const shipmentTrackingBlock = sourceBlock(
      FULFILLMENT_PUSH_SRC,
      "async function pushTrackingForShipment",
      "async function pushShopifyFulfillment",
    );
    const ebayRepushBlock = sourceBlock(
      EBAY_RECONCILER_SRC,
      "async repush(order: OmsOrder)",
      "async syncFulfillmentFromChannel",
    );

    expect(EBAY_FULFILLMENT_RECONCILER_TEST_SRC).toContain(
      "repushes shipped WMS shipments through the shipment-scoped path",
    );
    expect(EBAY_FULFILLMENT_RECONCILER_TEST_SRC).toContain(
      "enqueues an order-level delayed retry when fallback tracking push returns false",
    );
    expect(EBAY_TRACKING_PUSH_TEST_SRC).toContain(
      "fans out order-level tracking through shipped WMS shipments when they exist",
    );
    expect(EBAY_TRACKING_PUSH_TEST_SRC).toContain(
      "does NOT throw when createShippingFulfillment returns undefined",
    );
    expect(shipmentTrackingBlock).toContain("event_type = 'tracking_pushed'");
    expect(shipmentTrackingBlock).toContain("details->>'provider' = 'ebay'");
    expect(shipmentTrackingBlock).toContain("details->>'wmsShipmentId'");
    expect(shipmentTrackingBlock).toContain("details->>'trackingNumber'");
    expect(shipmentTrackingBlock).toContain("idempotent skip");
    expect(shipmentTrackingBlock).toContain("external_line_item_id");
    expect(shipmentTrackingBlock).toContain("lineItems");
    expect(shipmentTrackingBlock).toContain("wmsShipmentId: shipmentId");
    expect(ebayRepushBlock).toContain("pushTrackingForShipment(shipmentId)");
    expect(ebayRepushBlock).toContain("enqueueDelayedTrackingPush(this.db, orderId, shipmentId)");
    expect(ebayRepushBlock).toContain("pushTracking(orderId)");
    expect(ebayRepushBlock).toContain("enqueueDelayedTrackingPush(this.db, orderId)");
  });
});
