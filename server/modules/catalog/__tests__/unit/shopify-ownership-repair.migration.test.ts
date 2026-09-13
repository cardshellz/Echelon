import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0665_shopify_ownership_repair_commands.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/channels.schema.ts"),
  "utf8",
);

describe("Shopify ownership repair command schema", () => {
  it("adds only an empty idempotent command ledger", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS channels.shopify_ownership_repair_commands",
    );
    expect(migration).toContain(
      "shopify_ownership_repair_commands_idempotency_uidx",
    );
    expect(migration).toContain("recommendations JSONB NOT NULL");
    expect(migration).toContain(
      "ALTER COLUMN channel_variant_id DROP NOT NULL",
    );
    expect(migration).toContain(
      "CHECK (is_active = 0 OR NULLIF(btrim(channel_variant_id), '') IS NOT NULL)",
    );
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?catalog\./i);
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?channels\.channel_(?:feeds|listings)/i);
  });

  it("makes successful command receipts append-only", () => {
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON channels.shopify_ownership_repair_commands",
    );
    expect(migration).toContain(
      "BEFORE TRUNCATE ON channels.shopify_ownership_repair_commands",
    );
    expect(migration).toContain("ERRCODE = '55000'");
  });

  it("keeps the Drizzle contract aligned with the migration", () => {
    expect(schema).toContain(
      "export const shopifyOwnershipRepairCommands",
    );
    expect(schema).toContain(
      '"shopify_ownership_repair_commands"',
    );
    expect(schema).toContain(
      'uuid("idempotency_key").notNull()',
    );
    expect(schema).toContain(
      'varchar("request_hash", { length: 64 }).notNull()',
    );
    expect(schema).toContain(
      'varchar("preview_hash", { length: 64 }).notNull()',
    );
  });
});
