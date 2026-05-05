import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  buildShopifyWebhookInboxInput,
  buildWebhookIdempotencyKey,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
  recordWebhookReceived,
} from "../../webhook-inbox.service";

function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("webhook-inbox.service", () => {
  it("builds Shopify idempotency from webhook id, topic, and shop domain", () => {
    const input = buildShopifyWebhookInboxInput(
      req({
        "x-shopify-shop-domain": "example.myshopify.com",
        "x-shopify-webhook-id": "abc-123",
      }),
      "orders/paid",
      { id: 99, name: "#1001" },
    );

    expect(input.eventId).toBe("abc-123");
    expect(input.idempotencyKey).toBe("shopify:orders/paid:example.myshopify.com:abc-123");
    expect(input.sourceDomain).toBe("example.myshopify.com");
  });

  it("uses refund id plus order id when Shopify does not send a webhook id", () => {
    const input = buildShopifyWebhookInboxInput(
      req({ "x-shopify-shop-domain": "example.myshopify.com" }),
      "refunds/create",
      { id: 555, order_id: 777 },
    );

    expect(input.eventId).toBe("777:555");
    expect(input.idempotencyKey).toBe("shopify:refunds/create:example.myshopify.com:777:555");
  });

  it("keeps deterministic fallback ids for malformed payloads", () => {
    const first = buildShopifyWebhookInboxInput(req({}), "orders/updated", { b: 2, a: 1 });
    const second = buildShopifyWebhookInboxInput(req({}), "orders/updated", { a: 1, b: 2 });

    expect(first.eventId).toMatch(/^payload:/);
    expect(second.eventId).toBe(first.eventId);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("records a new inbox row and returns inserted=true", async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [{ id: 42, status: "received", attempts: 0, inserted: true }],
      })),
    };

    const receipt = await recordWebhookReceived(db, {
      provider: "shopify",
      topic: "orders/paid",
      eventId: "evt-1",
      idempotencyKey: buildWebhookIdempotencyKey({
        provider: "shopify",
        topic: "orders/paid",
        sourceDomain: "example.myshopify.com",
        eventId: "evt-1",
      }),
      sourceDomain: "example.myshopify.com",
      payload: { id: 1 },
      headers: {},
    });

    expect(receipt).toEqual({ id: 42, status: "received", attempts: 0, inserted: true });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("throws when the inbox write returns no row", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [] })) };

    await expect(recordWebhookReceived(db, {
      provider: "shopify",
      topic: "orders/paid",
      eventId: "evt-1",
      idempotencyKey: "shopify:orders/paid:unknown:evt-1",
      sourceDomain: null,
      payload: {},
      headers: {},
    })).rejects.toThrow(/Failed to record webhook inbox row/);
  });

  it("marks processing, succeeded, and failed states through explicit updates", async () => {
    const db = { execute: vi.fn(async () => ({ rows: [] })) };

    await markWebhookProcessing(db, 10);
    await markWebhookSucceeded(db, 10);
    await markWebhookFailed(db, 10, new Error("boom"));

    expect(db.execute).toHaveBeenCalledTimes(3);
  });
});
