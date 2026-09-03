import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0650_shipping_fulfillment_method_scope_capabilities.sql"),
  "utf8",
);

describe("shipping fulfillment method scope and capabilities migration", () => {
  it("makes destination scope part of persisted method identity", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX shipping_level_method_identity_idx[\s\S]+service_code,[\s\S]+domestic,[\s\S]+international/,
    );
    expect(migration).toContain("shipping_level_method_scope_chk");
  });

  it("captures capability snapshots while preserving historical rows", () => {
    expect(migration).toContain("ADD COLUMN provider_capabilities JSONB");
    expect(migration).toContain("shipping_level_method_scoped_capabilities_chk");
    expect(migration).toContain("guard_fulfillment_method_capabilities_write");
    expect(migration).toContain("OLD.provider_capabilities IS NULL");
    expect(migration).toContain("OLD.is_active OR NOT NEW.is_active");
    expect(migration).not.toMatch(
      /ADD CONSTRAINT shipping_level_method_scoped_capabilities_chk/,
    );
    expect(migration).toContain("supportsPrepaidDutiesTaxes");
    expect(migration).toContain("displaySchemes");
  });

  it("keeps coherence checks compatible with revisions created before capability snapshots", () => {
    expect(migration).toContain("current_snapshot_without_capabilities");
    expect(migration).toContain("snapshot_has_capabilities");
    expect(migration).toContain("WHEN snapshot_has_connection_identity AND snapshot_has_capabilities");
  });
});
