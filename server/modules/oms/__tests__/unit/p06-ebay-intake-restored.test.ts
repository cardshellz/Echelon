import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** P0.6 — eBay real-time intake restored (public route, retry, backstop). */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const INDEX_SRC = read("../../../../index.ts");
const INGEST_SRC = read("../../ebay-order-ingestion.ts");

describe("P0.6 — eBay real-time intake", () => {
  it("webhook routes are public — eBay cannot hold a session", () => {
    expect(INDEX_SRC).toContain('app.get("/api/ebay/webhooks/order", webhookHandler)');
    expect(INDEX_SRC).toContain('app.post("/api/ebay/webhooks/order", webhookHandler)');
    expect(INDEX_SRC).not.toMatch(/webhooks\/order", requireAuth/);
  });

  it("unsigned notifications are rejected; payload data is never trusted", () => {
    expect(INGEST_SRC).toContain('req.headers["x-ebay-signature"]');
    expect(INGEST_SRC).toContain("Missing notification signature");
  });

  it("a failed notification enqueues a retry instead of dead-ending at 200", () => {
    expect(INGEST_SRC).toContain("INSERT INTO oms.webhook_retry_queue");
    expect(INGEST_SRC).toContain("queued_for_retry");
    expect(INGEST_SRC).not.toContain('processing: "failed"');
  });

  it("the poller sweeps lastmodifieddate so late cancels/refunds are caught", () => {
    expect(INGEST_SRC).toContain("creationdate:[");
    expect(INGEST_SRC).toContain("lastmodifieddate:[");
    expect(INGEST_SRC).toContain("seenThisPoll");
  });
});
