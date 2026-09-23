import { describe, expect, it } from "vitest";
import { projectCustomerReturnLiveDelivery, CustomerReturnLiveDeliveryError } from "../../application/customer-return-live-delivery";
import type { CustomerReturnShopifySnapshot } from "../../application/customer-return-shopify-snapshot.ports";
import type { CustomerReturnLocalInspectionSnapshot } from "../../application/customer-return-local-inspection.ports";
import { evaluateCustomerReturnEligibility } from "../../domain/customer-return-eligibility";

const gid = (resource: string, id: number) => `gid://shopify/${resource}/${id}`;
const purchasedAt = "2026-09-01T12:00:00.000Z";
const inTransitAt = "2026-09-21T12:00:00.000Z";
const deliveredAt = "2026-09-22T12:00:00.000Z";
const observedAt = "2026-09-23T12:00:00.000Z";
function sources(): { shopify: CustomerReturnShopifySnapshot; local: CustomerReturnLocalInspectionSnapshot } {
  const shop = { channelId: 36, connectionId: 7, shopDomain: "fixture.myshopify.com", displayName: "Fixture" };
  const shopify: CustomerReturnShopifySnapshot = {
    shop: { ...shop, shopId: gid("Shop", 1), scopes: { readOrders: true, readAllOrders: true, readReturns: true } },
    apiVersion: "2026-07", observedAt,
    order: { id: gid("Order", 1001), name: "#TEST-1001", createdAt: purchasedAt, processedAt: purchasedAt,
      updatedAt: deliveredAt, cancelledAt: null, destinationCountryCode: "US" },
    lines: [{ id: gid("LineItem", 101), title: "Fictional product", variantTitle: null, sku: "SAME-SKU", quantity: 4,
      currentQuantity: 4, refundableQuantity: 4, requiresShipping: true }],
    fulfillments: [{ id: gid("Fulfillment", 201), status: "SUCCESS", updatedAt: deliveredAt, deliveredAt: null,
      inTransitAt, displayStatus: "FULFILLED", totalQuantity: 4,
      tracking: [{ number: "TRACK-501", company: "Carrier" }, { number: "TRACK-502", company: "Carrier" }],
      lines: [{ id: gid("FulfillmentLineItem", 301), lineItemId: gid("LineItem", 101), quantity: 4 }], events: [] }],
    returns: [], refunds: [], returnableFulfillments: [],
  };
  const local: CustomerReturnLocalInspectionSnapshot = {
    observedAt, shop,
    order: { omsOrderId: 1, channelId: 36, externalOrderId: "1001", externalOrderNumber: "#TEST-1001", purchasedAt,
      shipToCountry: "US", cancelledAt: null },
    lines: [{ omsOrderLineId: 11, externalLineItemId: "101", title: "Fictional product", variantTitle: null, sku: "SAME-SKU", quantity: 4, requiresShipping: true }],
    wmsItems: [41, 42].map(wmsOrderItemId => ({ wmsOrderId: 2, wmsOrderItemId, omsOrderLineId: 11, channelId: 36, source: "oms",
      omsOrderReference: "1", legacyOrderReference: "1", externalOrderId: "1001", externalLineItemId: "101", quantity: 2,
      fulfilledQuantity: 2, warehouseStatus: "shipped" })),
    rootClaims: [], legacyClaims: [], unallocatedReturns: [], inventoryReturnEvidence: [], issues: [],
    fulfillmentBindings: [0, 1].map(offset => ({ kind: "receipt", bindingId: offset + 1, parentId: 1, provider: "shopify", sourceChannelId: 36,
      sourceOrderId: "1001", fulfillmentId: "201", providerFulfillmentLineId: "101", purchasedLineId: "101", omsOrderLineId: 11,
      wmsOrderItemId: 41 + offset, physicalShipmentId: 501 + offset, physicalShipmentItemId: 51 + offset,
      quantity: 2, status: "processed", source: "webhook" })),
    packageItems: [0, 1].map(offset => ({ physicalShipmentItemId: 51 + offset, physicalShipmentId: 501 + offset,
      wmsOrderItemId: 41 + offset, omsOrderLineId: 11, legacyShipmentItemId: null, legacyShipmentId: null,
      purpose: "customer_fulfillment", replacementForOrderItemId: null, correctionForPhysicalShipmentItemId: null,
      originalQuantity: 2, effectiveQuantity: 2, status: "shipped", provider: "shipstation", trackingNumber: `TRACK-${501 + offset}`, carrier: "Carrier" })),
    packageLabels: [0, 1].map(offset => ({ linkId: 1 + offset, labelId: 601 + offset, physicalShipmentId: 501 + offset,
      provider: "shipstation", providerLabelId: `se-${601 + offset}`, trackingNumber: `TRACK-${501 + offset}`,
      normalizedTrackingNumber: `TRACK${501 + offset}`, carrier: "Carrier", status: "active", direction: "outbound", voidedAt: null })),
    carrierEvents: [0, 1].map(offset => ({ eventId: 701 + offset, matchId: 801 + offset, labelId: 601 + offset,
      canonicalStatus: "delivered", dispatchEvidence: "confirmed",
      occurredAt: offset ? deliveredAt : "2026-09-22T10:00:00.000Z", actualDeliveryAt: offset ? deliveredAt : "2026-09-22T10:00:00.000Z", receivedAt: observedAt })),
  };
  return { shopify, local };
}
function project(input = sources()) { return projectCustomerReturnLiveDelivery(input).get(gid("FulfillmentLineItem", 301))!; }
function eligible(input: ReturnType<typeof sources>) {
  const result = project(input);
  const evaluation = evaluateCustomerReturnEligibility({ now: observedAt, policy: { channelId: 36, version: 1, returnWindowDays: 365 },
    order: { orderId: input.shopify.order.id, channelId: 36, provider: "shopify", destinationCountryCode: "US", purchasedAt,
      lines: [{ lineId: gid("LineItem", 101), sku: "SAME-SKU", requiresShipping: true, purchasedQuantity: 4, claims: [],
        allocations: [{ allocationId: gid("FulfillmentLineItem", 301), fulfillmentId: gid("Fulfillment", 201), fulfillmentLineItemId: gid("FulfillmentLineItem", 301),
          quantity: 4, status: "active", deliveryEvidence: result.evidence, staffDeliveryOverride: null }] }] } });
  return result.blocked ? 0 : evaluation.eligibleQuantity;
}

describe("pure exact return delivery projection", () => {
  it("proves all parcels before granting a whole provider allocation", () => {
    const input = sources();
    const before = JSON.stringify(input);
    expect(project(input)).toMatchObject({ blocked: false });
    expect(project(input).evidence.filter(event => event.source === "carrier")).toEqual([
      expect.objectContaining({ status: "delivered", occurredAt: deliveredAt, evidenceId: expect.stringMatching(/^carrier-complete-allocation:/) }),
    ]);
    expect(eligible(input)).toBe(4);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("does not grant another parcel's units when only one parcel is delivered", () => {
    const input = sources();
    Object.assign(input.local.carrierEvents[1], { canonicalStatus: "in_transit", actualDeliveryAt: null });
    expect(project(input).evidence.some(event => event.status === "delivered")).toBe(false);
    expect(eligible(input)).toBe(0);
  });
  it("does not grant all units when one parcel has no carrier event", () => {
    const input = sources(); input.local.carrierEvents.pop();
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(0);
  });
  it("preserves Shopify delivery when all local projections are absent", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt;
    input.local.fulfillmentBindings = []; input.local.packageItems = []; input.local.packageLabels = []; input.local.carrierEvents = [];
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
  });
  it("preserves Shopify delivery with an incomplete noncontradictory local quantity projection", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt; input.local.fulfillmentBindings.pop();
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
    expect(project(input).evidence.filter(event => event.source === "carrier")).toEqual([]);
  });
  it("preserves Shopify delivery when exact mapping exists but labels are absent", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt; input.local.packageLabels = [];
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
  });
  it("uses exact Shopify fulfillment events without local package evidence", () => {
    const input = sources(); input.local.fulfillmentBindings = [];
    input.shopify.fulfillments[0].events = [{ id: gid("FulfillmentEvent", 901), status: "DELIVERED", happenedAt: deliveredAt }];
    expect(project(input).evidence).toContainEqual({ evidenceId: gid("FulfillmentEvent", 901), source: "shopify", status: "delivered", occurredAt: deliveredAt, observedAt });
    expect(eligible(input)).toBe(4);
  });
  it("does not use a display status without a delivery instant as delivery evidence", () => {
    const input = sources(); input.local.fulfillmentBindings = []; input.shopify.fulfillments[0].displayStatus = "DELIVERED";
    expect(eligible(input)).toBe(0);
  });
  it("does not treat an older carrier transit observation as contradiction of later Shopify delivery", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt;
    Object.assign(input.local.carrierEvents[1], { canonicalStatus: "in_transit", occurredAt: inTransitAt, actualDeliveryAt: null });
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
  });
  it("blocks newer carrier transit contradicting Shopify delivery", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt;
    Object.assign(input.local.carrierEvents[1], { canonicalStatus: "in_transit", occurredAt: observedAt, actualDeliveryAt: null });
    expect(project(input).blocked).toBe(true); expect(eligible(input)).toBe(0);
  });
  it("deduplicates exact receipt and push echoes without consuming their quantity twice", () => {
    const input = sources(); input.local.fulfillmentBindings.push(...input.local.fulfillmentBindings.map(binding => ({ ...binding,
      kind: "push" as const, providerFulfillmentLineId: null, status: "success", source: "channel_fulfillment_push" })));
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
  });
  it("does not let a canceled historical fulfillment consume its successful successor's physical capacity", () => {
    const input = sources();
    input.shopify.fulfillments.push({ ...structuredClone(input.shopify.fulfillments[0]),
      id: gid("Fulfillment", 202), status: "CANCELLED", displayStatus: "CANCELED",
      lines: [{ id: gid("FulfillmentLineItem", 302), lineItemId: gid("LineItem", 101), quantity: 4 }] });
    input.local.fulfillmentBindings.push(...input.local.fulfillmentBindings.map(binding => ({ ...binding,
      bindingId: binding.bindingId + 10, parentId: 2, fulfillmentId: "202" })));
    const projections = projectCustomerReturnLiveDelivery(input);
    expect(projections.get(gid("FulfillmentLineItem", 301))?.blocked).toBe(false);
    expect(projections.get(gid("FulfillmentLineItem", 302))?.evidence.some(event => event.source === "carrier")).toBe(false);
    expect(eligible(input)).toBe(4);
  });
  it("still blocks two successful provider allocations that overuse the same physical units", () => {
    const input = sources();
    input.shopify.lines[0].quantity = 8;
    input.shopify.lines[0].currentQuantity = 8;
    input.shopify.lines[0].refundableQuantity = 8;
    input.shopify.fulfillments.push({ ...structuredClone(input.shopify.fulfillments[0]),
      id: gid("Fulfillment", 202),
      lines: [{ id: gid("FulfillmentLineItem", 302), lineItemId: gid("LineItem", 101), quantity: 4 }] });
    input.local.fulfillmentBindings.push(...input.local.fulfillmentBindings.map(binding => ({ ...binding,
      bindingId: binding.bindingId + 10, parentId: 2, fulfillmentId: "202" })));
    const projections = projectCustomerReturnLiveDelivery(input);
    expect(projections.get(gid("FulfillmentLineItem", 301))?.blocked).toBe(true);
    expect(projections.get(gid("FulfillmentLineItem", 302))?.blocked).toBe(true);
  });
  it("accepts explicitly typed fulfillment-line receipt identity", () => {
    const input = sources(); input.local.fulfillmentBindings.forEach(binding => { binding.providerFulfillmentLineId = gid("FulfillmentLineItem", 301); });
    expect(eligible(input)).toBe(4);
  });
  it("does not mistake a purchased-line legacy receipt ID for a different GraphQL fulfillment-line ID", () => {
    const input = sources(); input.local.fulfillmentBindings[0].providerFulfillmentLineId = gid("FulfillmentLineItem", 101);
    expect(project(input).blocked).toBe(true); expect(eligible(input)).toBe(0);
  });
  it.each(["sourceChannelId", "sourceOrderId", "omsOrderLineId", "wmsOrderItemId", "physicalShipmentId", "physicalShipmentItemId"])("blocks conflicting binding %s", field => {
    const input = sources(); Object.assign(input.local.fulfillmentBindings[0], { [field]: field === "sourceOrderId" ? "999" : 999 });
    expect(project(input).blocked).toBe(true); expect(eligible(input)).toBe(0);
  });
  it("does not allow a missing field to hide a present conflicting binding", () => {
    const input = sources(); input.local.fulfillmentBindings[0].physicalShipmentItemId = null; input.local.fulfillmentBindings[0].wmsOrderItemId = 999;
    expect(project(input).blocked).toBe(true);
  });
  it.each(["replacement", "concession", "omission_correction"])("blocks %s package attribution", purpose => {
    const input = sources(); input.local.packageItems[0].purpose = purpose;
    expect(project(input).blocked).toBe(true);
  });
  it.each(["voided", "returned", "review"])("blocks %s physical packages", status => {
    const input = sources(); input.local.packageItems[0].status = status; expect(project(input).blocked).toBe(true);
  });
  it("rejects corrected-away quantity without treating the original historical quantity as capacity", () => {
    const input = sources(); input.local.packageItems[0].effectiveQuantity = 1;
    expect(project(input).blocked).toBe(true);
  });
  it("blocks conflicting receipt/push quantity for one physical allocation", () => {
    const input = sources(); input.local.fulfillmentBindings.push({ ...input.local.fulfillmentBindings[0], kind: "push", status: "success", quantity: 1, providerFulfillmentLineId: null });
    expect(project(input).blocked).toBe(true);
  });
  it("does not let an exact receipt in workflow review erase independent Shopify delivery", () => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt;
    input.local.fulfillmentBindings[0].status = "review";
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
    expect(project(input).evidence.some(event => event.source === "carrier")).toBe(false);
  });
  it("does not use an unaccepted receipt to complete a carrier-only quantity mapping", () => {
    const input = sources(); input.local.fulfillmentBindings[0].status = "review";
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(0);
  });
  it.each(["identity", "quantity"])("still blocks present %s contradiction on an unaccepted receipt", kind => {
    const input = sources(); input.shopify.fulfillments[0].deliveredAt = deliveredAt;
    input.local.fulfillmentBindings[0].status = "review";
    if (kind === "identity") input.local.fulfillmentBindings[0].wmsOrderItemId = 999;
    else input.local.fulfillmentBindings[0].quantity = 3;
    expect(project(input).blocked).toBe(true); expect(eligible(input)).toBe(0);
  });
  it.each(["voided", "superseded", "unknown"])("does not grant from %s labels", status => {
    const input = sources(); input.local.packageLabels[0].status = status; expect(project(input).blocked).toBe(true);
  });
  it("blocks a return-direction label even with delivered tracking", () => {
    const input = sources(); input.local.packageLabels[0].direction = "return"; expect(project(input).blocked).toBe(true);
  });
  it("blocks ambiguous active labels for one package", () => {
    const input = sources(); input.local.packageLabels.push({ ...input.local.packageLabels[0], linkId: 3, labelId: 999 });
    expect(project(input).blocked).toBe(true);
  });
  it("does not join a delivered tracking number onto an unbound package", () => {
    const input = sources(); input.local.fulfillmentBindings = []; expect(eligible(input)).toBe(0);
  });
  it("blocks a package label whose tracking contradicts the exact Shopify fulfillment", () => {
    const input = sources(); input.local.packageLabels[0].trackingNumber = "OTHER"; input.local.packageLabels[0].normalizedTrackingNumber = "OTHER";
    expect(project(input).blocked).toBe(true);
  });
  it("does not accept delivery to a service point as customer delivery", () => {
    const input = sources(); input.local.carrierEvents[1].canonicalStatus = "delivered_to_service_point"; input.local.carrierEvents[1].actualDeliveryAt = null;
    expect(eligible(input)).toBe(0);
  });
  it("blocks current carrier authority requiring review", () => {
    const input = sources(); input.local.carrierEvents[1].dispatchEvidence = "review"; expect(project(input).blocked).toBe(true);
  });
  it("blocks simultaneous contradictory matched carrier events", () => {
    const input = sources(); input.local.carrierEvents.push({ ...input.local.carrierEvents[1], eventId: 999, matchId: 999, canonicalStatus: "in_transit" });
    expect(project(input).blocked).toBe(true);
  });
  it("does not erase confirmed carrier delivery after a later unknown observation", () => {
    const input = sources(); input.local.carrierEvents.push({ ...input.local.carrierEvents[1], eventId: 999, matchId: 999,
      canonicalStatus: "unknown", dispatchEvidence: "not_confirmed", occurredAt: observedAt, actualDeliveryAt: null });
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
  });
  it("blocks a newer contradictory carrier event even without Shopify deliveredAt", () => {
    const input = sources(); input.local.carrierEvents.push({ ...input.local.carrierEvents[1], eventId: 999, matchId: 999,
      canonicalStatus: "in_transit", occurredAt: observedAt, actualDeliveryAt: null });
    expect(project(input).blocked).toBe(true); expect(eligible(input)).toBe(0);
  });
  it("uses the canonical delivered event time before a conflicting shipment summary delivery time", () => {
    const input = sources();
    input.local.carrierEvents[1].actualDeliveryAt = "2026-09-22T00:00:00.000Z";
    input.local.carrierEvents.push({ ...input.local.carrierEvents[1], eventId: 999, matchId: 999,
      canonicalStatus: "in_transit", occurredAt: "2026-09-22T09:00:00.000Z", actualDeliveryAt: null });
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
    expect(project(input).evidence.find(event => event.source === "carrier")?.occurredAt).toBe(deliveredAt);
  });
  it("falls back to actual delivery time only when the canonical delivered event has no time", () => {
    const input = sources(); input.local.carrierEvents[1].occurredAt = null;
    expect(project(input).blocked).toBe(false); expect(eligible(input)).toBe(4);
    expect(project(input).evidence.find(event => event.source === "carrier")?.occurredAt).toBe(deliveredAt);
  });
  it("does not hide known ambiguous labels behind incomplete quantity projection", () => {
    const input = sources(); input.local.fulfillmentBindings.pop();
    input.local.packageLabels.push({ ...input.local.packageLabels[0], linkId: 3, labelId: 999 });
    expect(project(input).blocked).toBe(true);
  });
  it("rejects mismatched store or duplicate local identity", () => {
    const input = sources(); input.local.shop.channelId = 37;
    expect(() => project(input)).toThrow(CustomerReturnLiveDeliveryError);
    const duplicate = sources(); duplicate.local.packageItems.push({ ...duplicate.local.packageItems[0] });
    expect(() => project(duplicate)).toThrow(CustomerReturnLiveDeliveryError);
  });
  it("projects identical evidence for equivalent source row order and tied timestamps", () => {
    const input = sources();
    input.shopify.fulfillments[0].events = [901, 902].map(id => ({ id: gid("FulfillmentEvent", id), status: "DELIVERED", happenedAt: deliveredAt }));
    const first = project(input);
    input.shopify.fulfillments[0].events.reverse(); input.local.fulfillmentBindings.reverse(); input.local.carrierEvents.reverse();
    expect(project(input)).toEqual(first);
  });
});
