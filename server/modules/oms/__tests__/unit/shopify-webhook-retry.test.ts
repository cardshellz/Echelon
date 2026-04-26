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

// ─── Source regression: shopify.routes.ts enqueue + bypass ───────────

describe("shopify.routes.ts :: enqueue on error + internal retry bypass", () => {
  it("imports webhookRetryQueue from @shared/schema", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(/webhookRetryQueue.*@shared\/schema|@shared\/schema.*webhookRetryQueue/);
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
    const shopifyEnqueues = SHOPIFY_ROUTES_SRC.match(/provider:\s*["']shopify["']/g);
    // Both fulfillments/create and fulfillments/update should enqueue with provider=shopify
    expect(shopifyEnqueues?.length).toBeGreaterThanOrEqual(2);
  });

  it("enqueues with payload=req.body", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(/payload:\s*req\.body/);
  });

  it("verifyChannelWebhook supports x-internal-retry bypass", () => {
    expect(SHOPIFY_ROUTES_SRC).toMatch(/x-internal-retry/);
    expect(SHOPIFY_ROUTES_SRC).toMatch(/SESSION_SECRET/);
    expect(SHOPIFY_ROUTES_SRC).toMatch(/verified:\s*true/);
  });
});
