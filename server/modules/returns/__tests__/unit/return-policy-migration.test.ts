import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/0612_return_policy_engine.sql", "utf8");

describe("return policy migration invariants", () => {
  it("creates immutable policy versions and idempotency commands", () => {
    expect(migration).toContain("CREATE TABLE returns.return_policies");
    expect(migration).toContain("CREATE TABLE returns.return_policy_commands");
    expect(migration).toContain("supersedes_policy_id integer REFERENCES returns.return_policies(id)");
    expect(migration).toContain("idempotency_key varchar(160) NOT NULL UNIQUE");
  });

  it("permits only one active version for each exact scope", () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX return_policies_active_scope_uq[\s\S]*WHERE status = 'active'/);
    expect(migration).toContain("CREATE UNIQUE INDEX return_policies_scope_version_uq ON returns.return_policies(scope_key, version)");
  });

  it("enforces scope dimensions and financial decision enums in the database", () => {
    expect(migration).toContain("CONSTRAINT return_policies_scope_dimensions_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_policies_payer_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_policies_settlement_trigger_chk CHECK");
  });
});
