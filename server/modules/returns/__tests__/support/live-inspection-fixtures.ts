import type { CustomerReturnLocalInspectionSnapshot } from "../../application/customer-return-local-inspection.ports";
import type { CustomerReturnShopifySnapshot } from "../../application/customer-return-shopify-snapshot.ports";

export const liveGid = (resource: string, id: number | string): string => `gid://shopify/${resource}/${id}`;
export const LIVE_NOW = "2026-09-23T12:00:00.000Z";
export const LIVE_PURCHASED = "2026-09-01T12:00:00.000Z";
export const liveShop = { channelId: 36, connectionId: 4, shopDomain: "fixture.myshopify.com", displayName: "Fixture shop" };
export function liveLocalFixture(): CustomerReturnLocalInspectionSnapshot {
  return { observedAt: LIVE_NOW, shop: { ...liveShop },
    order: { omsOrderId: 100, channelId: 36, externalOrderId: "1001", externalOrderNumber: "#0012-A",
      purchasedAt: LIVE_PURCHASED, shipToCountry: "US", cancelledAt: null },
    lines: [{ omsOrderLineId: 101, externalLineItemId: "501", title: "First", variantTitle: null, sku: "SAME", quantity: 3, requiresShipping: true, unitWeightGrams: 12.34 },
      { omsOrderLineId: 102, externalLineItemId: "502", title: "Second", variantTitle: null, sku: "SAME", quantity: 1, requiresShipping: true, unitWeightGrams: 20.01 }],
    wmsItems: [], rootClaims: [], legacyClaims: [], unallocatedReturns: [], inventoryReturnEvidence: [],
    fulfillmentBindings: [], packageItems: [], packageLabels: [], carrierEvents: [], issues: [],
  };
}
export function liveShopifyFixture(): CustomerReturnShopifySnapshot {
  const fulfillment = (id: number, line: number, quantity: number, delivered: boolean) => ({
    id: liveGid("Fulfillment", id), status: "SUCCESS" as const, updatedAt: "2026-09-20T12:00:00.000Z",
    deliveredAt: delivered ? "2026-09-20T12:00:00.000Z" : null,
    inTransitAt: "2026-09-19T12:00:00.000Z", displayStatus: delivered ? "DELIVERED" as const : "IN_TRANSIT" as const,
    totalQuantity: quantity, tracking: [],
    lines: [{ id: liveGid("FulfillmentLineItem", id + 100), lineItemId: liveGid("LineItem", line), quantity }], events: [],
  });
  return { observedAt: LIVE_NOW, apiVersion: "2026-07", shop: { ...liveShop, shopId: liveGid("Shop", 1),
    scopes: { readOrders: true, readAllOrders: true, readReturns: true } },
    order: { id: liveGid("Order", 1001), name: "#0012-A", createdAt: LIVE_PURCHASED, processedAt: LIVE_PURCHASED,
      updatedAt: "2026-09-20T12:00:00.000Z", cancelledAt: null, destinationCountryCode: "US", shippingAddress: null },
    lines: [{ id: liveGid("LineItem", 501), title: "First", variantTitle: null, sku: "SAME", quantity: 3, currentQuantity: 3, refundableQuantity: 3, requiresShipping: true },
      { id: liveGid("LineItem", 502), title: "Second", variantTitle: null, sku: "SAME", quantity: 1, currentQuantity: 1, refundableQuantity: 1, requiresShipping: true }],
    fulfillments: [fulfillment(601, 501, 2, true), fulfillment(602, 501, 1, false), fulfillment(603, 502, 1, true)],
    returns: [], refunds: [], returnableFulfillments: [],
  };
}
export function liveNativeReturn(quantity = 1): CustomerReturnShopifySnapshot["returns"][number] {
  return { id: liveGid("Return", 801), status: "OPEN", totalQuantity: quantity,
    lines: [{ id: liveGid("ReturnLineItem", 901), fulfillmentLineItemId: liveGid("FulfillmentLineItem", 701),
      lineItemId: liveGid("LineItem", 501), quantity, processedQuantity: 0, refundedQuantity: 0 }] };
}

/** One explicit whole physical package, containing two separate same-SKU lines. */
export function addLiveOriginalBox(local: CustomerReturnLocalInspectionSnapshot): void {
  local.wmsItems = local.lines.map((line, index) => ({ wmsOrderId: 200, wmsOrderItemId: 301 + index,
    omsOrderLineId: line.omsOrderLineId, channelId: 36, source: "oms", omsOrderReference: "100", legacyOrderReference: null,
    externalOrderId: "1001", externalLineItemId: line.externalLineItemId, quantity: line.quantity,
    fulfilledQuantity: line.quantity, warehouseStatus: "shipped" }));
  local.packageItems = local.lines.map((line, index) => ({ physicalShipmentId: 401, physicalShipmentItemId: 501 + index,
    wmsOrderItemId: 301 + index, omsOrderLineId: line.omsOrderLineId, legacyShipmentItemId: null, legacyShipmentId: null,
    purpose: "customer_fulfillment", replacementForOrderItemId: null, correctionForPhysicalShipmentItemId: null,
    originalQuantity: index === 0 ? 2 : 1, effectiveQuantity: index === 0 ? 2 : 1, status: "shipped", provider: "shipstation",
    providerPhysicalShipmentId: "601", trackingNumber: "TRACK601", carrier: "UPS" }));
  local.packageLabels = [{ linkId: 701, labelId: 801, physicalShipmentId: 401, provider: "shipstation",
    providerLabelId: "label601", trackingNumber: "TRACK601", normalizedTrackingNumber: "TRACK601", carrier: "UPS",
    status: "active", direction: "outbound", voidedAt: null }];
}
