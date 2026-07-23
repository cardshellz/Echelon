/**
 * Unit tests for Shopify webhook retry + DLQ (§6 Commit 30).
 *
 * Covers:
 *   1. recordRetryFailure dead-letter formatting for shopify topics
 *   2. Source-level regression: fulfillments routes enqueue on error
 *   3. Source-level regression: worker shopify branch URL mapping
 *   4. Source-level regression: x-internal-retry bypass in shopify routes
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The worker's top-level `import { db } from "../../db"` would otherwise
// try to build a real Postgres client at import time and fail on
// DATABASE_URL. We never exercise that default-db path in this file — all
// tests inject their own db mock — so a no-op stand-in is sufficient.
vi.mock("../../../../db", () => ({
  db: {
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    execute: async () => ({ rows: [] }),
  },
}));

import { recordRetryFailure } from "../../webhook-retry.worker";
import {
  buildShopifyFulfillmentRetryEnvelope,
  enqueueShopifyFulfillmentWebhookRetry,
  receiptRecoveryOwnedStatus,
  sourceChannelIdFromRetryPayload,
  sourceEventIdFromRetryPayload,
} from "../../shopify-fulfillment-webhook-retry";

// ─── DB mock helpers ─────────────────────────────────────────────────

interface RecordedUpdate {
  table: unknown;
  set: any;
  where: unknown;
}

function makeDb(opts: { updateThrows?: Error } = {}) {
  const updates: RecordedUpdate[] = [];

  const db: any = {
    update: vi.fn((table: any) => ({
      set: vi.fn((set: any) => ({
        where: vi.fn(async (_where: any) => {
          if (opts.updateThrows) throw opts.updateThrows;
          updates.push({ table, set, where: _where });
          return undefined;
        }),
      })),
    })),
  };

  return { db, updates };
}

// ─── Source files for regression checks ──────────────────────────────

const WORKER_SRC = readFileSync(
  resolve(__dirname, "../../webhook-retry.worker.ts"),
  "utf-8",
);
const SHOPIFY_ROUTES_SRC = readFileSync(
  resolve(__dirname, "../../../../routes/shopify.routes.ts"),
  "utf-8",
);
const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);
const FULFILLMENT_RETRY_SRC = readFileSync(
  resolve(__dirname, "../../shopify-fulfillment-webhook-retry.ts"),
  "utf-8",
);

// ─── recordRetryFailure: shopify dead-letter formatting ──────────────

describe("recordRetryFailure :: shopify dead-letter formatting", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits CRITICAL: log with topic, queue row ID, attempts, and error for generic shopify topic", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { db } = makeDb();

    await recordRetryFailure(
      db,
      { id: 42, attempts: 4, topic: "orders/paid" },
      "DB connection timeout",
    );

    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeDefined();
    const logStr = String(critical![0]);
    expect(logStr).toContain("orders/paid");
    expect(logStr).toContain("Queue Row ID: 42");
    expect(logStr).toContain("Attempts: 5");
    expect(logStr).toContain("DB connection timeout");
  });

  it("emits CRITICAL: with shopify_fulfillment_push headline", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { db } = makeDb();

    await recordRetryFailure(
      db,
      { id: 99, attempts: 4, topic: "shopify_fulfillment_push" },
      "push failed",
      { topic: "shopify_fulfillment_push", shipmentId: 77 },
    );

    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeDefined();
    expect(String(critical![0])).toContain("Shopify Fulfillment Push Dead-Lettered");
    expect(String(critical![0])).toContain("Shipment ID: 77");
  });

  it("does NOT emit CRITICAL on transient failures (pending status)", async () => {
    const errSpy = vi.spyOn(console, "error");
    const { db } = makeDb();

    await recordRetryFailure(
      db,
      { id: 10, attempts: 1, topic: "fulfillments/create" },
      "transient error",
    );

    const critical = errSpy.mock.calls.find((args) =>
      String(args[0] ?? "").startsWith("CRITICAL:"),
    );
    expect(critical).toBeUndefined();
  });

  it("applies exponential backoff: 2^(attempts+1) minutes", async () => {
    const { db } = makeDb();
    const before = Date.now();

    const result = await recordRetryFailure(
      db,
      { id: 1, attempts: 2, topic: "refunds/create" },
      "temp fail",
    );

    expect(result.attempts).toBe(3);
    expect(result.status).toBe("pending");
    const expectedDelayMs = Math.pow(2, 3) * 60_000; // 8 minutes
    expect(result.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + expectedDelayMs - 50);
  });
});

// ─── Source regression: worker shopify branch ────────────────────────

describe("webhook-retry.worker.ts :: shopify provider branch", () => {
  it("has a dedicated provider==='shopify' branch before the legacy fallback", () => {
    expect(WORKER_SRC).toMatch(/item\.provider\s*===\s*["']shopify["']/);
  });

  it("maps fulfillments/* topics to /api/shopify/webhooks/ path", () => {
    expect(WORKER_SRC).toContain("/api/shopify/webhooks");
    expect(WORKER_SRC).toMatch(/fulfillments\/create|fulfillments\/update/);
  });

  it("maps orders/* and refunds/* topics to /api/oms/webhooks/ path", () => {
    // The shopify branch should use /api/oms/webhooks for non-fulfillment topics
    expect(WORKER_SRC).toContain("/api/oms/webhooks");
  });

  it("marks unknown topics dead immediately without retry", () => {
    expect(WORKER_SRC).toMatch(/Unknown topic/);
    expect(WORKER_SRC).toMatch(/status:\s*["']dead["']/);
  });

  it("includes x-internal-retry header in shopify loopback requests", () => {
    expect(WORKER_SRC).toMatch(/"x-internal-retry":\s*secret/);
  });

  it("emits shopify-specific CRITICAL: format with Topic and Order on dead-letter", () => {
    // The shopify branch should emit a custom CRITICAL log (not just the
    // generic one from recordRetryFailure) that includes topic + order ID
    expect(WORKER_SRC).toContain("CRITICAL: Shopify Webhook Dead-Lettered");
    expect(WORKER_SRC).toMatch(/Topic:.*\$\{item\.topic\}/);
    expect(WORKER_SRC).toMatch(/Order:.*orderId/);
  });
});

describe("oms-webhooks.ts :: internal retry loopback semantics", () => {
  it("does not early-ack x-internal-retry loopbacks", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("function acknowledgeAccepted");
    expect(OMS_WEBHOOKS_SRC).toMatch(/if \(!isInternalRetry\(req\)\)/);
  });

  it("returns 500 on internal retry processing failure", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("function handleProcessingFailure");
    expect(OMS_WEBHOOKS_SRC).toMatch(/isInternalRetry\(req\)[\s\S]*res\.status\(500\)/);
  });

  it("acks completed processing and idempotent no-ops when no response was sent yet", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("function acknowledgeProcessed");
    expect(OMS_WEBHOOKS_SRC).toMatch(/acknowledgeProcessed\(req, res\)/);
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /function acknowledgeProcessed\(_req: Request, res: Response\): void \{[\s\S]*if \(!res\.headersSent\)/,
    );
    expect(OMS_WEBHOOKS_SRC).not.toMatch(
      /function acknowledgeProcessed[\s\S]*isInternalRetry\(req\)[\s\S]*res\.status\(200\)/,
    );
  });

  it("persists Shopify OMS webhooks to an inbox before acknowledging", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("receiveShopifyWebhook");
    expect(OMS_WEBHOOKS_SRC).toContain("recordWebhookReceived");
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /receiveShopifyWebhook\(req, res, "orders\/paid", shopifyOrder\)[\s\S]*acknowledgeAccepted\(req, res\)/,
    );
  });

  it("allows internal retries to reprocess already-succeeded inbox rows", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /!receipt\.inserted && receipt\.status === "succeeded" && !isInternalRetry\(req\)/,
    );
    expect(OMS_WEBHOOKS_SRC).toMatch(
      /!receipt\.inserted && receipt\.status === "succeeded" && isInternalRetry\(req\)[\s\S]*internal retry replaying succeeded inbox row/,
    );
  });

  it("marks inbox rows succeeded or failed around processing", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("markInboxSucceeded");
    expect(OMS_WEBHOOKS_SRC).toContain("markInboxFailed");
  });
});

// ─── Source regression: retry rows must link back to their inbox row ──
// Without sourceInboxId on the enqueued retry row, the retry worker cannot
// mirror a successful retry back onto the originating webhook_inbox row, so
// the inbox row stays 'failed' forever and ops dashboards (ops-health,
// flow-waterfall WEBHOOK_INBOX_FAILED) report a permanent false positive.

describe("oms-webhooks.ts :: retry rows carry sourceInboxId", () => {
  it("handleProcessingFailure persists the originating inbox id on the retry row", () => {
    expect(OMS_WEBHOOKS_SRC).toMatch(/sourceInboxId:\s*args\.sourceInboxId/);
  });

  it("every handleProcessingFailure call site passes inbox.receipt.id", () => {
    const calls =
      OMS_WEBHOOKS_SRC.match(/await handleProcessingFailure\(req, res, \{[\s\S]*?\}\);/g) ?? [];
    // orders/paid, orders/updated, orders/cancelled, orders/fulfilled, refunds/create
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call).toMatch(/sourceInboxId:\s*inbox\.receipt\.id/);
    }
  });
});

// ─── Source regression: shopify.routes.ts enqueue + bypass ───────────

describe("shopify.routes.ts :: bounded fulfillment retry + internal retry bypass", () => {
  it("delegates failed fulfillment delivery to the idempotent retry helper", () => {
    expect(SHOPIFY_ROUTES_SRC).toContain("enqueueShopifyFulfillmentWebhookRetry");
    expect(FULFILLMENT_RETRY_SRC).toContain(".onConflictDoNothing()");
  });

  it("fulfillments/create catch block enqueues with topic 'fulfillments/create'", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /topic:\s*["']fulfillments\/create["']/,
    );
  });

  it("fulfillments/update catch block enqueues with topic 'fulfillments/update'", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /topic:\s*["']fulfillments\/update["']/,
    );
  });

  it("enqueues with provider 'shopify'", () => {
    expect(FULFILLMENT_RETRY_SRC).toMatch(/provider:\s*["']shopify["']/);
  });

  it("does not enqueue a child retry from an internal loopback", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /if \(input\.webhookVerified && !isInternalRetryRequest\(input\.req\)\)[\s\S]*enqueueShopifyFulfillmentWebhookRetry/,
    );
  });

  it("acknowledges deliveries already owned by canonical receipt recovery", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /receiptRecoveryOwnedStatus\(input\.error\)[\s\S]*status\(200\)/,
    );
  });

  it("only enqueues externally delivered payloads after HMAC verification", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /if \(input\.webhookVerified && !isInternalRetryRequest\(input\.req\)\)/,
    );
    expect(SHOPIFY_ROUTES_SRC).toMatch(/webhookVerified = true/);
  });

  it("verifyChannelWebhook supports x-internal-retry bypass", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(/x-internal-retry/);
    expect(SHOPIFY_ROUTES_SRC).toMatch(/SESSION_SECRET/);
    expect(SHOPIFY_ROUTES_SRC).toMatch(/verified:\s*true/);
  });

  it("does not authenticate an absent retry header when SESSION_SECRET is absent", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(
      /const secret = process\.env\.SESSION_SECRET\?\.trim\(\);[\s\S]*if \(!secret\) return false/,
    );
  });
});

describe("Shopify fulfillment retry event identity", () => {
  it("preserves Shopify event, channel, and shop identity in a stable retry envelope", () => {
    const envelope = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/update",
      payload: { id: 6330164707487, order_id: 12167289405599 },
      sourceEventId: "7bec3250-e0b7-3f75-4331-28cd89477e2e",
      sourceChannelId: 36,
      shopDomain: "Card-Shellz.MyShopify.com",
    });

    expect(envelope.retryKey).toBe(
      "shopify-fulfillment-webhook:v1:fulfillments/update:36:card-shellz.myshopify.com:7bec3250-e0b7-3f75-4331-28cd89477e2e",
    );
    expect(sourceEventIdFromRetryPayload(envelope.payload)).toBe(
      "7bec3250-e0b7-3f75-4331-28cd89477e2e",
    );
    expect(sourceChannelIdFromRetryPayload(envelope.payload)).toBe(36);
  });

  it("uses a deterministic payload hash when Shopify event identity is unavailable", () => {
    const first = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/create",
      payload: { order_id: 100, id: 200 },
      sourceEventId: null,
      sourceChannelId: null,
      shopDomain: null,
    });
    const second = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/create",
      payload: { id: 200, order_id: 100 },
      sourceEventId: null,
      sourceChannelId: null,
      shopDomain: null,
    });

    expect(first.retryKey).toBe(second.retryKey);
  });

  it("does not collapse distinct updates for one fulfillment when event identity is unavailable", () => {
    const first = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/update",
      payload: {
        order_id: 100,
        id: 200,
        tracking_number: "TRACKING-ONE",
      },
      sourceEventId: null,
      sourceChannelId: 36,
      shopDomain: "card-shellz.myshopify.com",
    });
    const second = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/update",
      payload: {
        order_id: 100,
        id: 200,
        tracking_number: "TRACKING-TWO",
      },
      sourceEventId: null,
      sourceChannelId: 36,
      shopDomain: "card-shellz.myshopify.com",
    });

    expect(first.retryKey).not.toBe(second.retryKey);
  });

  it("enqueues with the stable key and conflict-safe insert semantics", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const envelope = buildShopifyFulfillmentRetryEnvelope({
      topic: "fulfillments/update",
      payload: { id: 200, order_id: 100 },
      sourceEventId: "event-1",
      sourceChannelId: 36,
      shopDomain: "card-shellz.myshopify.com",
    });

    await enqueueShopifyFulfillmentWebhookRetry(
      { insert },
      {
        topic: "fulfillments/update",
        envelope,
        errorMessage: "temporary failure",
      },
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      provider: "shopify",
      topic: "fulfillments/update",
      retryKey: envelope.retryKey,
      payload: envelope.payload,
      lastError: "temporary failure",
    }));
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("classifies active and deferred receipts as recovery-owned acknowledgements", () => {
    expect(receiptRecoveryOwnedStatus({ code: "RECEIPT_ALREADY_PROCESSING" }))
      .toBe("processing");
    expect(receiptRecoveryOwnedStatus({ code: "RECEIPT_RETRY_NOT_DUE" }))
      .toBe("pending");
    expect(receiptRecoveryOwnedStatus({ code: "ECONNRESET" })).toBeNull();
  });
});
