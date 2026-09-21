import { describe, expect, it, vi } from "vitest";
import { parseWalmartOrder, WalmartUsApi } from "../../adapters/walmart/walmart-us-api";
import { mapWalmartOrder, walmartCents, validateWalmartOrderScope } from "../../adapters/walmart/walmart-order.domain";
import { prepareWalmartShipment } from "../../adapters/walmart/walmart-fulfillment";
import { deriveOmsLineAuthority } from "../../../oms/oms-line-authority";
import { walmartOrderFixture } from "./walmart-fixture";

describe("Walmart order financial and quantity contracts", () => {
  it.each([["0", 0], ["0.29", 29], ["19.99", 1999], ["21474836.47", 2147483647]])("converts %s exactly to cents", (value, cents) => expect(walmartCents(value)).toBe(cents));
  it.each(["-1", "1.001", "NaN", "1e3", "21474836.48", ""]) ("rejects invalid money %s", value => expect(() => walmartCents(value)).toThrow());
  it("does not authorize Created observations, then authorizes acknowledged quantities", () => {
    const observed = mapWalmartOrder(parseWalmartOrder(walmartOrderFixture()), "NODE-1", false);
    expect(observed).toMatchObject({ totalCents: 2119, subtotalCents: 1999, taxCents: 120, sourceTopic: "walmart/observed" });
    expect(observed.lineItems[0]).toMatchObject({ paidPriceCents: 1999, taxCents: 120, fulfillableQuantity: 0 });
    expect(deriveOmsLineAuthority({ ...observed.lineItems[0], sourceTopic: observed.sourceTopic!, financialStatus: observed.financialStatus }).paidQuantity).toBe(0);
    const data = mapWalmartOrder(parseWalmartOrder(walmartOrderFixture("Acknowledged")), "NODE-1", true);
    expect(deriveOmsLineAuthority({ ...data.lineItems[0], sourceTopic: data.sourceTopic!, financialStatus: data.financialStatus }).authorityFulfillableQuantity).toBe(1);
  });
  it.each(["Cancelled"])("does not materialize %s units", state => {
    expect(mapWalmartOrder(parseWalmartOrder(walmartOrderFixture(state)), "NODE-1", true).lineItems[0].fulfillableQuantity).toBe(0);
  });
  it.each(["Shipped", "Delivered"])("preserves paid warehouse authority at commercial %s while closing the header to new materialization", state => {
    const data = mapWalmartOrder(parseWalmartOrder(walmartOrderFixture(state)), "NODE-1", true);
    expect(data.fulfillmentStatus).toBe("fulfilled");
    expect(data.lineItems[0].fulfillableQuantity).toBe(1);
  });
  it("never regrants a previously cancelled line on replay", () => {
    const result = deriveOmsLineAuthority({ sourceTopic: "walmart/acknowledged", financialStatus: "paid", quantity: 1, fulfillableQuantity: 1,
      previous: { paidQuantity: 1, cancelledQuantity: 1, refundedQuantity: 0, authorityFulfillableQuantity: 0 } });
    expect(result.authorityFulfillableQuantity).toBe(0);
  });
  it("rejects unmatched nodes, replacement orders and unsupported financial cases", () => {
    const order = parseWalmartOrder(walmartOrderFixture());
    expect(() => validateWalmartOrderScope(order, "OTHER")).toThrow(/another fulfillment/);
    expect(() => mapWalmartOrder({ ...order, orderType: "REPLACEMENT" }, "NODE-1", false)).toThrow(/Replacement/);
    expect(() => mapWalmartOrder(parseWalmartOrder(walmartOrderFixture("Acknowledged", "2")), "NODE-1", true)).toThrow(/Multi-quantity/);
    expect(() => mapWalmartOrder(parseWalmartOrder(walmartOrderFixture("Refund")), "NODE-1", true)).toThrow(/refund/);
  });
  it("rejects inconsistent status quantities and duplicate line identities", () => {
    const order = parseWalmartOrder(walmartOrderFixture());
    const line = order.orderLines.orderLine[0];
    expect(() => validateWalmartOrderScope({ ...order, orderLines: { orderLine: [line, line] } }, "NODE-1")).toThrow(/duplicate/);
    line.orderLineQuantity.amount = 2;
    expect(() => validateWalmartOrderScope(order, "NODE-1")).toThrow(/complete ordered quantity/);
  });
});

describe("Walmart US API boundary", () => {
  it("validates returned inventory identity and reads after absolute updates", async () => {
    const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ sku: "SKU", quantity: { unit: "EACH", amount: 0 } });
    await new WalmartUsApi({ request }).setInventory("SKU", "NODE", 0);
    expect(request.mock.calls).toEqual([["PUT", "/v3/inventory?sku=SKU&shipNode=NODE", { sku: "SKU", quantity: { unit: "EACH", amount: 0 } }], ["GET", "/v3/inventory?sku=SKU&shipNode=NODE"]]);
    request.mockResolvedValue({ sku: "OTHER", quantity: { unit: "EACH", amount: 1 } });
    await expect(new WalmartUsApi({ request }).inventory("SKU", "NODE")).rejects.toMatchObject({ code: "WALMART_SKU_MISMATCH" });
  });
  it("confirms acknowledgment with a separate exact-order read", async () => {
    const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ order: walmartOrderFixture("Acknowledged") });
    const api = new WalmartUsApi({ request });
    expect((await api.acknowledge("PO-123")).orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0].status).toBe("Acknowledged");
    expect(request.mock.calls[1]).toEqual(["GET", "/v3/orders/PO-123?replacementInfo=true"]);
  });
  it("rejects malformed responses without exposing provider values", async () => {
    const api = new WalmartUsApi({ request: vi.fn().mockResolvedValue({ secret: "NEVER-LOG" }) });
    await expect(api.order("PO")).rejects.toMatchObject({ code: "WALMART_RESPONSE_INVALID" });
  });
});

describe("Walmart durable shipment request", () => {
  const input = { omsOrderId: 17, trackingNumber: "TRACK-1", carrier: "ups", shippedAt: new Date("2026-09-21T12:00:00Z"), items: [{
    legacyWmsShipmentId: 1, legacyWmsShipmentItemId: 2, omsOrderLineId: 3, channelOrderLineId: "1", quantity: 1,
  }] };
  it("builds exact line quantities and recognizes a previously successful post", () => {
    const result = prepareWalmartShipment(parseWalmartOrder(walmartOrderFixture("Acknowledged")), input);
    expect(result.alreadySatisfied).toBe(false);
    expect(result.body).toMatchObject({ orderShipment: { orderLines: { orderLine: [{ sellerOrderId: "17", orderLineStatuses: { orderLineStatus: [{ trackingInfo: { carrierName: { carrier: "UPS" }, shipDateTime: input.shippedAt.getTime() } }] } }] } } });
    expect(prepareWalmartShipment(parseWalmartOrder(walmartOrderFixture("Shipped")), input).alreadySatisfied).toBe(true);
  });
  it.each(["Created", "Cancelled", "Refund"])("blocks shipping a %s line", state => expect(() => prepareWalmartShipment(parseWalmartOrder(walmartOrderFixture(state)), input)).toThrow(/cancelled, unacknowledged/));
  it("rejects missing dates, unknown carriers, tracking changes and silent notification", () => {
    const order = parseWalmartOrder(walmartOrderFixture("Acknowledged"));
    expect(() => prepareWalmartShipment(order, { ...input, shippedAt: null })).toThrow(/persisted shipment date/);
    expect(() => prepareWalmartShipment(order, { ...input, carrier: "guessed" })).toThrow(/supported carrier/);
    expect(() => prepareWalmartShipment(order, { ...input, notifyCustomer: false })).toThrow(/Silent/);
    expect(() => prepareWalmartShipment(parseWalmartOrder(walmartOrderFixture("Shipped")), { ...input, trackingNumber: "NEW" })).toThrow(/different tracking/);
  });
});
