import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildEbayWebhookInboxInput,
  buildShopifyWebhookInboxInput,
  buildWebhookIdempotencyKey,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
  enqueueWebhookInboxReplay,
  recordWebhookReceived,
} from "../../webhook-inbox.service";

const WEBHOOK_INBOX_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../webhook-inbox.service.ts"),
  "utf-8",
);

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

  it("builds eBay idempotency from notification id and topic", () => {
    const input = buildEbayWebhookInboxInput(
      req({
        "user-agent": "ebay",
        "x-ebay-transmission-id": "tx-1",
      }),
      {
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "note-1",
          data: { orderId: "12-34567-89012" },
        },
      },
    );

    expect(input.provider).toBe("ebay");
    expect(input.topic).toBe("MARKETPLACE_ACCOUNT_DELETION");
    expect(input.eventId).toBe("note-1");
    expect(input.idempotencyKey).toBe("ebay:MARKETPLACE_ACCOUNT_DELETION:ebay:note-1");
  });

  it("falls back to eBay topic and order id when notification id is absent", () => {
    const input = buildEbayWebhookInboxInput(
      req({}),
      {
        metadata: { topic: "ORDER.CREATED" },
        notification: {
          data: { orderId: "12-34567-89012" },
        },
      },
    );

    expect(input.eventId).toBe("ORDER.CREATED:12-34567-89012");
    expect(input.idempotencyKey).toBe("ebay:ORDER.CREATED:ebay:ORDER.CREATED:12-34567-89012");
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

  it("queues an immediate retry for a failed Shopify OMS inbox row", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 10,
            provider: "shopify",
            topic: "orders/paid",
            payload: { id: 99 },
            status: "failed",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 77 }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await enqueueWebhookInboxReplay(db, 10, "ops@example.com");

    expect(result).toEqual({
      inboxId: 10,
      retryQueueId: 77,
      provider: "shopify",
      topic: "orders/paid",
      previousStatus: "failed",
    });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("queues an immediate retry for a failed eBay order inbox row", async () => {
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 11,
            provider: "ebay",
            topic: "ORDER.CREATED",
            payload: { notification: { data: { orderId: "12-34567-89012" } } },
            status: "failed",
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 78 }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await enqueueWebhookInboxReplay(db, 11, "ops@example.com");

    expect(result).toEqual({
      inboxId: 11,
      retryQueueId: 78,
      provider: "ebay",
      topic: "ORDER.CREATED",
      previousStatus: "failed",
    });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("links replay retry rows back to the source inbox row", () => {
    expect(WEBHOOK_INBOX_SERVICE_SRC).toContain("source_inbox_id");
    expect(WEBHOOK_INBOX_SERVICE_SRC).toContain("${inboxId}");
  });

  it("rejects succeeded inbox rows so operators do not replay completed events", async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [{
          id: 10,
          provider: "shopify",
          topic: "orders/paid",
          payload: { id: 99 },
          status: "succeeded",
        }],
      })),
    };

    await expect(enqueueWebhookInboxReplay(db, 10, "ops@example.com"))
      .rejects.toThrow(/already succeeded/);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported topics instead of inserting malformed retry rows", async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [{
          id: 10,
          provider: "shopify",
          topic: "fulfillments/create",
          payload: { id: 99 },
          status: "failed",
        }],
      })),
    };

    await expect(enqueueWebhookInboxReplay(db, 10, "ops@example.com"))
      .rejects.toThrow(/not a replayable OMS webhook topic/);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
