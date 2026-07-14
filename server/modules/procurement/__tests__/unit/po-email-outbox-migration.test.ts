import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/138_po_email_outbox.sql"),
  "utf8",
);

describe("PO email outbox migration", () => {
  it("enforces idempotent request identity and durable lease state", () => {
    expect(migration).toContain("po_email_outbox_idempotency_idx");
    expect(migration).toContain("po_email_outbox_message_id_idx");
    expect(migration).toContain("po_email_outbox_lease_chk");
    expect(migration).toContain("po_email_outbox_sent_timestamp_chk");
    expect(migration).toContain("po_email_outbox_dead_timestamp_chk");
  });

  it("makes request snapshots and terminal states database-immutable", () => {
    expect(migration).toContain("po_email_outbox_update_guard");
    expect(migration).toContain("request snapshots are immutable");
    expect(migration).toContain("terminal states are immutable");
    expect(migration).toContain("OLD.status = 'processing'");
    expect(migration).toContain("'queued', 'sent', 'partially_sent', 'dead_letter'");
  });
});
