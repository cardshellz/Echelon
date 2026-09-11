import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0664_oms_historical_line_identity_repair_commands.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/oms.schema.ts"),
  "utf8",
);

describe("historical order-line identity repair command schema", () => {
  it("adds only an inert command table and never runs a historical backfill", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS oms.historical_order_line_identity_repair_commands");
    expect(migration).not.toMatch(/UPDATE\s+(oms\.oms_order_lines|wms\.order_items)/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+(oms\.oms_order_lines|wms\.order_items)/i);
    expect(migration).not.toContain("DO $$");
  });

  it("enforces immutable command identity and explicit repair lifecycle evidence", () => {
    expect(migration).toContain("idempotency_key UUID NOT NULL");
    expect(migration).toContain("request_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("preview_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("CHECK (status IN ('claim_pending', 'succeeded', 'failed'))");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS oms_hist_line_identity_repair_idempotency_uidx");
    expect(migration).toContain("CHECK (jsonb_typeof(target_oms_line_ids) = 'array')");
  });

  it("keeps the Drizzle schema aligned with the migration", () => {
    expect(schema).toContain("export const omsHistoricalLineIdentityRepairCommands");
    for (const column of [
      'uuid("idempotency_key")',
      'varchar("request_hash", { length: 64 })',
      'varchar("preview_hash", { length: 64 })',
      'jsonb("target_oms_line_ids")',
      'jsonb("repair_result")',
      'jsonb("claim_result")',
    ]) {
      expect(schema).toContain(column);
    }
  });
});
