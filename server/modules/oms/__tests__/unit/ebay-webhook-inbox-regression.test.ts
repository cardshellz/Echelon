import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EBAY_INGESTION_SRC = readFileSync(
  resolve(__dirname, "../../ebay-order-ingestion.ts"),
  "utf-8",
);
const WEBHOOK_RETRY_WORKER_SRC = readFileSync(
  resolve(__dirname, "../../webhook-retry.worker.ts"),
  "utf-8",
);
const SERVER_INDEX_SRC = readFileSync(
  resolve(__dirname, "../../../../index.ts"),
  "utf-8",
);

describe("ebay-order-ingestion.ts :: webhook inbox regression", () => {
  it("records eBay webhook notifications to the durable inbox before ack", () => {
    expect(EBAY_INGESTION_SRC).toContain("buildEbayWebhookInboxInput");
    expect(EBAY_INGESTION_SRC).toContain("recordWebhookReceived");
    expect(EBAY_INGESTION_SRC).toMatch(
      /recordWebhookReceived\(db, buildEbayWebhookInboxInput\(req, payload\)\)[\s\S]*markWebhookProcessing/,
    );
  });

  it("does not acknowledge when the durable inbox write fails", () => {
    expect(EBAY_INGESTION_SRC).toMatch(/Inbox write failed[\s\S]*res\.status\(500\)/);
  });

  it("marks eBay webhook inbox rows succeeded or failed around processing", () => {
    expect(EBAY_INGESTION_SRC).toContain("markWebhookSucceeded");
    expect(EBAY_INGESTION_SRC).toContain("markWebhookFailed");
  });

  it("routes eBay replay rows through the in-process retry worker", () => {
    expect(WEBHOOK_RETRY_WORKER_SRC).toContain("dispatchEbayWebhookRetry");
    expect(WEBHOOK_RETRY_WORKER_SRC).toMatch(/item\.provider === "ebay"[\s\S]*dispatchEbayWebhookRetry/);
    expect(WEBHOOK_RETRY_WORKER_SRC).toContain("__ebayWebhookReplay");
  });

  it("wires the eBay replay service during server boot", () => {
    expect(SERVER_INDEX_SRC).toContain("__ebayWebhookReplay");
    expect(SERVER_INDEX_SRC).toMatch(/__ebayWebhookReplay[\s\S]*reingestEbayOrder/);
  });
});
