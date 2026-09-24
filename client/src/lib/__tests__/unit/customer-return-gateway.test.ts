import { describe, expect, it, vi } from "vitest";
import {
  createLiveReturnGateway,
  createSampleReturnGateway,
} from "../../customer-return-gateway";
import type {
  ReturnPreviewOrder,
  ReturnPreviewReview,
} from "@shared/returns/customer-return-preview.contract";
import type { CustomerReturnFlowReviewInput } from "@shared/returns/customer-return-flow.contract";

const dimensions = { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 };

const sampleOrder: ReturnPreviewOrder = {
  mode: "admin_preview",
  scenarioId: "split_delivered",
  orderReference: "#1001",
  purchasedAt: "2026-01-01T00:00:00Z",
  evaluatedAt: "2026-02-01T00:00:00Z",
  returnWindowEndsAt: "2027-01-01T00:00:00Z",
  message: null,
  boxOptions: [
    {
      id: "original-1",
      dimensions,
      items: [{ lineId: "line-1", quantity: 2 }],
    },
  ],
  lines: [
    {
      id: "line-1",
      title: "Sleeves",
      variant: "Clear",
      sku: "SLV",
      unitWeightGrams: 100,
      purchasedQuantity: 2,
      deliveredQuantity: 2,
      alreadyReturningQuantity: 0,
      eligibleQuantity: 2,
      message: null,
    },
  ],
};
const sampleReview: ReturnPreviewReview = {
  mode: "admin_preview",
  effects: "none",
  orderReference: "#1001",
  selectedQuantity: 1,
  parcels: [
    {
      number: 1,
      dimensions,
      weightGrams: 100,
      items: [{ lineId: "line-1", title: "Sleeves", quantity: 1 }],
    },
  ],
  refundMethod: "manual_shopify",
};
const input: CustomerReturnFlowReviewInput = {
  orderReference: "#1001",
  sourceRevision: null,
  selections: [{ lineId: "line-1", quantity: 1, reasonCode: null }],
  parcels: [
    {
      dimensions,
      originalBoxId: "original-1",
      items: [{ lineId: "line-1", quantity: 1 }],
    },
  ],
};
function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("customer return source gateways", () => {
  it("preserves sample API shapes while removing scenario metadata from the shared flow", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) =>
        response(sampleOrder),
    );
    request
      .mockResolvedValueOnce(response(sampleOrder))
      .mockResolvedValueOnce(response(sampleReview));
    const gateway = createSampleReturnGateway("split_delivered", request);
    const signal = new AbortController().signal;
    const order = await gateway.lookup("1001", signal);
    const review = await gateway.review(input, signal);
    expect(order.sourceRevision).toBeNull();
    expect(order).not.toHaveProperty("scenarioId");
    expect(order).not.toHaveProperty("mode");
    expect(review.sourceRevision).toBeNull();
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      scenarioId: "split_delivered",
      orderReference: "1001",
    });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({
      scenarioId: "split_delivered",
      orderReference: input.orderReference,
      selections: input.selections,
      parcels: input.parcels,
    });
    expect(request.mock.calls[0][1]?.signal).toBe(signal);
    expect(request.mock.calls[1][1]?.cache).toBe("no-store");
  });

  it("binds live reads and reviews to the selected shop and original source revision", async () => {
    const sourceRevision = "a".repeat(64);
    const { mode: _sampleMode, scenarioId: _scenario, ...fields } = sampleOrder;
    const request = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => response(null),
    );
    request
      .mockResolvedValueOnce(
        response({ ...fields, mode: "admin_live", sourceRevision }),
      )
      .mockResolvedValueOnce(
        response({ ...sampleReview, mode: "admin_live", sourceRevision }),
      );
    const gateway = createLiveReturnGateway(36, request);
    const signal = new AbortController().signal;
    const order = await gateway.lookup("#1001", signal);
    const review = await gateway.review(
      { ...input, sourceRevision: order.sourceRevision },
      signal,
    );
    expect(order.sourceRevision).toBe(sourceRevision);
    expect(review.sourceRevision).toBe(sourceRevision);
    expect(request.mock.calls[0][0]).toBe(
      "/api/returns/admin/portal-preview/live/order",
    );
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      channelId: 36,
      orderReference: "#1001",
    });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({
      ...input,
      channelId: 36,
      sourceRevision,
    });
  });

  it("rejects live review without a revision and sample review with a live revision before sending a request", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => response(null),
    );
    const signal = new AbortController().signal;
    await expect(
      createLiveReturnGateway(36, request).review(input, signal),
    ).rejects.toThrow();
    await expect(
      createSampleReturnGateway("split_delivered", request).review(
        { ...input, sourceRevision: "a".repeat(64) },
        signal,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a response for a different sample scenario instead of silently remapping it", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) =>
        response({ ...sampleOrder, scenarioId: "in_transit" }),
    );
    await expect(
      createSampleReturnGateway("split_delivered", request).lookup(
        "1001",
        new AbortController().signal,
      ),
    ).rejects.toThrow("sample order response could not be verified");
  });
});
