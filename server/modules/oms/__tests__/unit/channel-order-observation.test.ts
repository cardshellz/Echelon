import { describe, expect, it } from "vitest";
import { channelOrderObservationSchema, reconcileChannelOrderLineDisposition, type ChannelOrderObservation } from "../../channel-order-observation";

const line = { externalLineItemId: "1", quantity: 3, cancelledQuantity: 1, paidPriceCents: 100, totalCents: 300, providerStates: [] };
const before = { quantity: 3, cancelled_quantity: 0, refunded_quantity: 0, authority_fulfillable_quantity: 3, authorization_status: "paid" };
const observation: ChannelOrderObservation = {
  channelId: 1, provider: "walmart", externalOrderId: "PO-1", orderId: 2, actor: "test", observedAt: new Date("2026-09-21T00:00:00Z"),
  sourceEventId: "event-1", status: "confirmed", fulfillmentStatus: "unfulfilled",
  subtotalCents: 300, shippingCents: 0, taxCents: 0, totalCents: 300, rawPayload: {}, lines: [line],
};

describe("OMS channel-observation boundary", () => {
  it("reduces authority monotonically without mutating either input", () => {
    const current = Object.freeze({ ...before });
    const observed = Object.freeze({ ...line });
    expect(reconcileChannelOrderLineDisposition(observed, current)).toEqual({
      ...before, cancelled_quantity: 1, authority_fulfillable_quantity: 2, authorization_status: "partially_cancelled",
    });
    expect(current).toEqual(before);
    expect(observed).toEqual(line);
    expect(reconcileChannelOrderLineDisposition(line, { ...before, authority_fulfillable_quantity: 0 }).authority_fulfillable_quantity).toBe(0);
  });
  it("applies full cancellation and preserves unrelated authority status on a no-op", () => {
    expect(reconcileChannelOrderLineDisposition({ ...line, cancelledQuantity: 3 }, before)).toMatchObject({ authorization_status: "cancelled", authority_fulfillable_quantity: 0 });
    expect(reconcileChannelOrderLineDisposition({ ...line, cancelledQuantity: 0 }, before)).toEqual(before);
  });
  it.each([{ quantity: 2 }, { cancelled_quantity: 2 }, { refunded_quantity: 1 }])("rejects conflicting persisted disposition %j", override => {
    expect(() => reconcileChannelOrderLineDisposition(line, { ...before, ...override })).toThrow(expect.objectContaining({ code: "OMS_ORDER_AUTHORITY_CONFLICT" }));
  });
  it.each([
    { channelId: 0 }, { orderId: Number.MAX_SAFE_INTEGER + 1 }, { actor: " " }, { provider: "walmart;unsafe" },
    { totalCents: 0.5 }, { totalCents: -1 }, { observedAt: new Date("invalid") },
    { lines: [] }, { lines: [line, line] }, { lines: [{ ...line, cancelledQuantity: 4 }] },
  ])("rejects invalid observations at the owner boundary: %j", override => {
    expect(channelOrderObservationSchema.safeParse({ ...observation, ...override }).success).toBe(false);
  });
  it("accepts exact zero and maximum integer cents", () => {
    expect(channelOrderObservationSchema.parse({ ...observation, totalCents: 0 }).totalCents).toBe(0);
    expect(channelOrderObservationSchema.parse({ ...observation, totalCents: 2_147_483_647 }).totalCents).toBe(2_147_483_647);
  });
});
