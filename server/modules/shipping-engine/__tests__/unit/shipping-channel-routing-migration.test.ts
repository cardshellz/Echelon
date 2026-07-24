import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/166_shipping_channel_routing_foundation.sql"),
  "utf8",
);
const operationsMigration = readFileSync(
  resolve(process.cwd(), "migrations/167_shipping_channel_routing_operations.sql"),
  "utf8",
);

describe("shipping channel routing foundation migration", () => {
  it("creates reusable destination scopes and versioned channel policies", () => {
    expect(migration).toContain("CREATE TABLE shipping.destination_scopes");
    expect(migration).toContain("CREATE TABLE shipping.destination_scope_members");
    expect(migration).toContain("CREATE TABLE shipping.channel_policies");
    expect(migration).toContain("CREATE TABLE shipping.channel_policy_routes");
    expect(migration).toContain("CREATE TABLE shipping.channel_policy_route_destinations");
    expect(migration).toContain("REFERENCES channels.channels(id)");
  });

  it("allows only one active version per canonical channel and purpose", () => {
    expect(migration).toContain("shipping_channel_policy_version_idx");
    expect(migration).toContain("shipping_channel_policy_active_idx");
    expect(migration).toContain("WHERE status = 'active'");
  });

  it("encodes the three routing modes and their rate-book invariants", () => {
    expect(migration).toContain(
      "CHECK (mode IN ('engine_quoted', 'channel_managed', 'disabled'))",
    );
    expect(migration).toContain(
      "CHECK (eligibility_mode IN ('engine', 'channel', 'intersection', 'none'))",
    );
    expect(migration).toContain("mode = 'engine_quoted'");
    expect(migration).toContain("rate_book_id IS NOT NULL");
    expect(migration).toContain("mode = 'disabled'");
    expect(migration).toContain("eligibility_mode = 'none'");
  });

  it("does not seed guessed channel IDs or change existing runtime assignments", () => {
    expect(migration).not.toMatch(/\b(?:36|37|67|103)\b/);
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.rate_book_assignments/i,
    );
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.channel_policies/i,
    );
  });

  it("stores no per-vendor or per-store routing key", () => {
    expect(migration).not.toMatch(/vendor_id|store_connection_id/);
  });

  it("freezes destination membership inside each policy revision", () => {
    expect(migration).toContain("source_destination_scope_id");
    expect(migration).toContain("shipping_channel_policy_route_destination_idx");
    expect(migration).toContain("Frozen destination membership");
  });
});

describe("shipping channel routing operations migration", () => {
  it("adds optimistic locking to operator-managed records", () => {
    expect(operationsMigration).toContain(
      "ALTER TABLE shipping.destination_scopes",
    );
    expect(operationsMigration).toContain(
      "ALTER TABLE shipping.channel_policies",
    );
    expect(operationsMigration).toContain(
      "ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 1",
    );
    expect(operationsMigration).toContain("CHECK (lock_version > 0)");
  });

  it("enforces one draft per channel and purpose under concurrency", () => {
    expect(operationsMigration).toContain(
      "shipping_channel_policy_draft_idx",
    );
    expect(operationsMigration).toContain("WHERE status = 'draft'");
  });

  it("preserves discarded drafts as retired revisions without pretending they activated", () => {
    expect(operationsMigration).toContain(
      "DROP CONSTRAINT shipping_channel_policy_lifecycle_chk",
    );
    expect(operationsMigration).toMatch(
      /status = 'retired'[\s\S]*activated_by IS NULL[\s\S]*activated_at IS NULL/,
    );
  });

  it("does not seed or activate any channel policy", () => {
    expect(operationsMigration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?shipping\.channel_policies/i,
    );
    expect(operationsMigration).not.toMatch(/\b(?:36|37|67|103)\b/);
  });
});
