import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import type { EbayShippingFulfillmentRequest } from "../../adapters/ebay/ebay-types";

const base = "https://api.ebay.com";
const examples = [
  { orderId: "08-15140-13597", lineItemId: "10083776958108", tracking: "9400150106151382305802", quantity: 3 },
  { orderId: "14-15129-29548", lineItemId: "10084705501414", tracking: "9434650106151135924856", quantity: 1 },
];

function fixture(example = examples[0]) {
  const { orderId, lineItemId, tracking, quantity } = example;
  const path = `/sell/fulfillment/v1/order/${orderId}`;
  const collection = { total: 1, fulfillments: [{ fulfillmentId: tracking,
    shipmentTrackingNumber: tracking, shippedDate: "2026-09-08T10:31:56.000Z",
    lineItems: [{ lineItemId }],
  }] };
  const order = { orderId, orderFulfillmentStatus: "FULFILLED",
    fulfillmentHrefs: [`${base}${path}/shipping_fulfillment/${tracking}`],
    cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [] },
    lineItems: [{ lineItemId, quantity, lineItemFulfillmentStatus: "FULFILLED" }],
  };
  const expected: EbayShippingFulfillmentRequest = { lineItems: [{ lineItemId, quantity }],
    shippedDate: "2026-09-08T10:31:56.000Z", shippingCarrierCode: "USPS", trackingNumber: tracking };
  return { orderId, path, collection, order, expected };
}

function harness(input = fixture(), options: {
  first?: unknown; order?: unknown; second?: unknown;
  failStage?: "order" | "second"; strict?: boolean;
} = {}) {
  let collections = 0;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method !== "GET") throw new Error("This recovery must never POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer pinned-test-token");
    if (url === `${base}${input.path}/shipping_fulfillment`) {
      collections += 1;
      if (collections > 1 && options.failStage === "second") throw new Error("private-read-body");
      return Response.json(collections === 1 ? options.first ?? input.collection : options.second ?? input.collection);
    }
    if (url === `${base}${input.path}`) {
      if (options.failStage === "order") throw new Error("private-read-body");
      return Response.json(options.order ?? input.order);
    }
    throw new Error("Unexpected provider URL");
  });
  const getAccessToken = vi.fn().mockResolvedValue("pinned-test-token");
  const client = new EbayApiClient({ getAccessToken }, 67, "production", { request,
    strictFulfillmentReadback: options.strict ?? true });
  return { client, request, getAccessToken };
}

afterEach(() => vi.restoreAllMocks());

describe("canonical eBay omitted-quantity evidence", () => {
  it.each(examples)("uses provider quantity $quantity for $orderId without POSTing or refreshing authorization", async (example) => {
    const input = fixture(example);
    const before = structuredClone(input);
    const h = harness(input);
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).resolves.toEqual({
      fulfillmentId: example.tracking, quantityEvidenceSource: "provider_fulfilled_whole_order",
    });
    expect(h.getAccessToken).toHaveBeenCalledExactlyOnceWith(67);
    expect(h.request.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${base}${input.path}/shipping_fulfillment`, "GET"], [`${base}${input.path}`, "GET"],
      [`${base}${input.path}/shipping_fulfillment`, "GET"],
    ]);
    expect(input).toEqual(before);
  });

  it("does not derive the missing quantity from the expected command", async () => {
    const input = fixture();
    input.expected.lineItems[0].quantity = 1; // Provider order independently proves three.
    const h = harness(input);
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each([2, 1])("corroborates explicit quantities too when another line omits quantity (explicit=%s)", async (explicitQuantity) => {
    const input = fixture();
    const first = { ...input.collection, fulfillments: [{ ...input.collection.fulfillments[0], lineItems: [
      { lineItemId: examples[0].lineItemId }, { lineItemId: "second-line", quantity: explicitQuantity },
    ] }] };
    const order = { ...input.order, lineItems: [...input.order.lineItems,
      { lineItemId: "second-line", quantity: 2, lineItemFulfillmentStatus: "FULFILLED" }] };
    const expected = { ...input.expected, lineItems: [...input.expected.lineItems, { lineItemId: "second-line", quantity: 2 }] };
    const h = harness(input, { first, second: first, order });
    if (explicitQuantity === 2) {
      await expect(h.client.createShippingFulfillment(input.orderId, expected)).resolves.toMatchObject({
        quantityEvidenceSource: "provider_fulfilled_whole_order",
      });
      expect(h.request).toHaveBeenCalledTimes(3);
    } else {
      await expect(h.client.createShippingFulfillment(input.orderId, expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
      expect(h.request).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["fulfillment", "order"] as const)("rejects duplicate line identities in the provider %s", async (scope) => {
    const input = fixture();
    const first = { ...input.collection, fulfillments: [{ ...input.collection.fulfillments[0], lineItems: [
      { lineItemId: examples[0].lineItemId }, { lineItemId: scope === "fulfillment" ? examples[0].lineItemId : "second-line" },
    ] }] };
    const order = { ...input.order, lineItems: [input.order.lineItems[0], input.order.lineItems[0]] };
    const h = harness(input, { first, order });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(scope === "fulfillment" ? 1 : 2);
  });

  it.each([null, 0, -1, true, false, "3", "bad", 1.5, Number.MAX_SAFE_INTEGER + 1])("never treats explicit invalid quantity %j as omission", async (quantity) => {
    const input = fixture();
    const first = { ...input.collection, fulfillments: [{ ...input.collection.fulfillments[0],
      lineItems: [{ lineItemId: examples[0].lineItemId, quantity }] }] };
    const h = harness(input, { first });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit quantity mismatches without consulting order totals", async () => {
    const input = fixture();
    const h = harness(input, { first: { ...input.collection, fulfillments: [{ ...input.collection.fulfillments[0],
      lineItems: [{ lineItemId: examples[0].lineItemId, quantity: 2 }] }] } });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { orderId: "foreign-order" }, { orderFulfillmentStatus: "IN_PROGRESS" },
    { cancelStatus: { cancelState: "CANCELED", cancelRequests: [] } },
    { cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [{}] } },
    { cancelStatus: { cancelState: "NONE_REQUESTED" } },
    { fulfillmentHrefs: [] }, { fulfillmentHrefs: ["https://attacker.invalid/private"] },
    { fulfillmentHrefs: [`${base}/sell/fulfillment/v1/order/foreign/shipping_fulfillment/${examples[0].tracking}`] },
    { fulfillmentHrefs: [`${base}/sell/fulfillment/v1/order/${examples[0].orderId}/shipping_fulfillment/foreign`] },
    { fulfillmentHrefs: ["a", "b"] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: 3, lineItemFulfillmentStatus: "IN_PROGRESS" }] },
    { lineItems: [{ lineItemId: "foreign", quantity: 3, lineItemFulfillmentStatus: "FULFILLED" }] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: null, lineItemFulfillmentStatus: "FULFILLED" }] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: 0, lineItemFulfillmentStatus: "FULFILLED" }] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: true, lineItemFulfillmentStatus: "FULFILLED" }] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: "3", lineItemFulfillmentStatus: "FULFILLED" }] },
    { lineItems: [{ lineItemId: examples[0].lineItemId, quantity: 3, lineItemFulfillmentStatus: "FULFILLED" },
      { lineItemId: "extra", quantity: 1, lineItemFulfillmentStatus: "FULFILLED" }] },
  ])("rejects contradictory or incomplete provider order evidence: %j", async (override) => {
    const input = fixture();
    const h = harness(input, { order: { ...input.order, ...override } });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each([undefined, "", "bad-date"])("requires a completed fulfillment timestamp (%j)", async (shippedDate) => {
    const input = fixture();
    const h = harness(input, { first: { ...input.collection,
      fulfillments: [{ ...input.collection.fulfillments[0], shippedDate }] } });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("does not infer package quantity from an order with multiple fulfillments", async () => {
    const input = fixture();
    const h = harness(input, { first: { total: 2, fulfillments: [input.collection.fulfillments[0],
      { ...input.collection.fulfillments[0], fulfillmentId: "other", shipmentTrackingNumber: "other" }] } });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(["tracking", "line", "quantity", "timestamp", "collection"])("fails closed when second full collection changes %s", async (change) => {
    const input = fixture();
    const row = input.collection.fulfillments[0];
    const changed = change === "tracking" ? { ...row, shipmentTrackingNumber: "other" }
      : change === "line" ? { ...row, lineItems: [{ lineItemId: "other" }] }
      : change === "quantity" ? { ...row, lineItems: [{ lineItemId: examples[0].lineItemId, quantity: 3 }] }
      : { ...row, shippedDate: "2026-09-08T10:31:57.000Z" };
    const h = harness(input, { second: change === "collection" ? { total: 0, fulfillments: [] } : { total: 1, fulfillments: [changed] } });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "EBAY_FULFILLMENT_READBACK_CHANGED", failureClass: "transient" });
    expect(h.request).toHaveBeenCalledTimes(3);
  });

  it.each(["order", "second"] as const)("never POSTs or leaks provider errors after %s read failure", async (failStage) => {
    const input = fixture();
    const h = harness(input, { failStage });
    const error = await h.client.createShippingFulfillment(input.orderId, input.expected).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "EBAY_FULFILLMENT_QUANTITY_EVIDENCE_UNAVAILABLE", failureClass: "transient" });
    expect(String(error)).not.toContain("private-read-body");
    expect(h.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("does not enable the new inference for legacy clients", async () => {
    const input = fixture();
    const h = harness(input, { strict: false });
    await expect(h.client.createShippingFulfillment(input.orderId, input.expected)).rejects.toMatchObject({ code: "ebay_fulfillment_idempotency_conflict" });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});
