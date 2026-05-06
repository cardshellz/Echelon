import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EBAY_INGESTION_SRC = readFileSync(
  resolve(__dirname, "../../ebay-order-ingestion.ts"),
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
});
