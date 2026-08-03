import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../../../migrations/180_webhook_retry_pending_source_inbox_unique.sql"),
  "utf8",
);

describe("webhook retry source inbox pending uniqueness migration", () => {
  it("retires redundant pending attempts before enforcing one runnable retry per inbox event", () => {
    expect(MIGRATION).toContain("PARTITION BY source_inbox_id");
    expect(MIGRATION).toContain("ranked.row_number > 1");
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX uq_webhook_retry_pending_source_inbox[\s\S]*ON oms\.webhook_retry_queue\(source_inbox_id\)[\s\S]*WHERE status = 'pending'[\s\S]*source_inbox_id IS NOT NULL/,
    );
  });
});
