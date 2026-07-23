import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/164_channel_fulfillment_receipt_retry_control.sql"),
  "utf8",
);

describe("channel fulfillment receipt retry control migration", () => {
  it("adds a distinct consecutive failure counter and due time", () => {
    expect(migration).toContain("retry_failure_count INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("next_retry_at TIMESTAMPTZ");
    expect(migration).toContain("outcome IN ('processed', 'ignored', 'review', 'retryable', 'lease_expired')");
  });

  it("guards failure-count transitions and retry scheduling in the database", () => {
    expect(migration).toContain("retry_failure_count must be monotonic");
    expect(migration).toContain("can only finish an active processing attempt");
    expect(migration).toContain("Only pending channel fulfillment receipts may have next_retry_at");
  });

  it("deduplicates only pending transport rows by stable retry identity", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS retry_key VARCHAR(1000)");
    expect(migration).toContain("PARTITION BY provider, topic, retry_key");
    expect(migration).toContain(
      "NULLIF(payload->>'__echelon_source_event_id', '')",
    );
    expect(migration).toContain("md5(payload::text)");
    expect(migration).not.toContain(
      "COALESCE(NULLIF(payload->>'id', ''), md5(payload::text))",
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uq_webhook_retry_queue_pending_retry_key[\s\S]*WHERE status = 'pending'[\s\S]*retry_key IS NOT NULL/,
    );
  });

  it("hands pre-cutover retries with canonical receipts to receipt recovery", () => {
    expect(migration).toContain(
      "Canonical channel fulfillment receipt owns recovery after retry-control cutover",
    );
    expect(migration).toContain("retry.retry_key LIKE 'legacy:%'");
    expect(migration).toContain(
      "idx_webhook_retry_queue_shopify_fulfillment_payload",
    );
  });

  it("protects retry identity across rolling deploys and later updates", () => {
    expect(migration).toContain("webhook_retry_queue_retry_key_guard");
    expect(migration).toContain("TG_OP = 'INSERT'");
    expect(migration).toContain("NEW.retry_key IS NULL");
    expect(migration).toContain("Webhook retry identity is immutable");
  });
});
