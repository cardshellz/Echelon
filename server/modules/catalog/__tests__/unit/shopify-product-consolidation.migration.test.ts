import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0666_shopify_product_consolidation_commands.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/channels.schema.ts"),
  "utf8",
);

describe("Shopify product consolidation command schema", () => {
  it("deploys only an empty evidence and command ledger", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS channels.shopify_product_consolidation_commands",
    );
    expect(migration).toContain("evidence JSONB NOT NULL");
    expect(migration).toContain("plan JSONB NOT NULL");
    expect(migration).toContain("result JSONB NOT NULL");
    expect(migration).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:catalog|inventory|warehouse)\./i,
    );
  });

  it("makes successful receipts append-only", () => {
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON channels.shopify_product_consolidation_commands",
    );
    expect(migration).toContain(
      "BEFORE TRUNCATE ON channels.shopify_product_consolidation_commands",
    );
    expect(migration).toContain("ERRCODE = '55000'");
  });

  it("keeps the Drizzle contract aligned with the migration", () => {
    expect(schema).toContain(
      "export const shopifyProductConsolidationCommands",
    );
    expect(schema).toContain('"shopify_product_consolidation_commands"');
    expect(schema).toContain('jsonb("source_product_ids")');
    expect(schema).toContain('jsonb("evidence").notNull()');
  });
});
