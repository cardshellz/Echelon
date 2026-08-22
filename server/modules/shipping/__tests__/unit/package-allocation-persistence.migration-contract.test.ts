import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const ledgerMigrationSource = readNormalizedSource(
  "migrations",
  "198_package_allocation_ledger_foundation.sql",
);
const persistenceMigrationSource = readNormalizedSource(
  "migrations",
  "199_package_allocation_persistence_foundation.sql",
);
const schemaSource = readNormalizedSource("shared", "schema", "fulfillment.schema.ts");
const persistenceMigrationSql = persistenceMigrationSource.replace(/\s+/g, " ").trim();

describe("package allocation persistence migration contract", () => {
  it("adds immutable provider-qualified, label-neutral package identity with Drizzle parity", () => {
    expect(persistenceMigrationSource).toContain(
      "CREATE TABLE wms.package_allocation_package_bindings",
    );
    expect(persistenceMigrationSql).toContain(
      "CONSTRAINT uq_package_allocation_package_bindings_group_key UNIQUE (package_allocation_group_id, package_key)",
    );
    expect(persistenceMigrationSql).toContain(
      "CONSTRAINT uq_package_allocation_package_bindings_provider_identity UNIQUE (provider, provider_physical_shipment_id)",
    );
    expect(persistenceMigrationSql).toContain(
      "CONSTRAINT uq_package_allocation_package_bindings_id_group UNIQUE (id, package_allocation_group_id)",
    );
    expect(persistenceMigrationSql).toContain(
      "CONSTRAINT fk_package_allocation_package_bindings_group FOREIGN KEY (package_allocation_group_id) REFERENCES wms.package_allocation_groups(id) ON DELETE RESTRICT",
    );
    expect(persistenceMigrationSource).toContain(
      "package_allocation_package_bindings_text_chk",
    );
    expect(persistenceMigrationSource).toContain(
      "package_allocation_package_bindings_hash_chk",
    );
    expect(persistenceMigrationSource).toContain(
      "CREATE TRIGGER trg_package_allocation_package_bindings_immutable",
    );

    expect(schemaSource).toContain(
      'wmsSchema.table("package_allocation_package_bindings"',
    );
    expect(schemaSource).toContain(
      'packageKey: varchar("package_key", { length: 180 }).notNull()',
    );
    expect(schemaSource).toContain(
      'providerPhysicalShipmentId: varchar("provider_physical_shipment_id", { length: 200 }).notNull()',
    );
    expect(schemaSource).toContain(
      'identityHash: varchar("identity_hash", { length: 64 }).notNull()',
    );
    for (const constraintName of [
      "uq_package_allocation_package_bindings_group_key",
      "uq_package_allocation_package_bindings_provider_identity",
      "uq_package_allocation_package_bindings_id_group",
      "package_allocation_package_bindings_text_chk",
      "package_allocation_package_bindings_hash_chk",
    ]) {
      expect(schemaSource).toContain(`"${constraintName}"`);
    }
    expect(schemaSource).toContain(
      "insertPackageAllocationPackageBindingSchema",
    );
    expect(schemaSource).toContain(
      "export type PackageAllocationPackageBinding =",
    );
  });

  it("locks and rejects any unexpected Slice 1 ledger history before changing identity", () => {
    expect(persistenceMigrationSource).toContain("IN ACCESS EXCLUSIVE MODE");
    for (const tableName of [
      "package_allocation_groups",
      "package_allocation_source_lines",
      "package_allocation_group_source_lines",
      "package_allocation_keys",
      "package_allocation_plans",
      "package_allocation_entries",
      "package_allocation_effect_intents",
    ]) {
      expect(persistenceMigrationSource).toContain(
        `EXISTS (SELECT 1 FROM wms.${tableName})`,
      );
    }
    expect(persistenceMigrationSource).toContain(
      "package allocation persistence migration requires an empty inert ledger",
    );
  });

  it("binds package targets and effect evidence to the immutable package identity", () => {
    expect(
      persistenceMigrationSource.match(
        /ADD COLUMN package_allocation_package_binding_id BIGINT/g,
      ),
    ).toHaveLength(2);
    expect(persistenceMigrationSource).toContain(
      "fk_package_allocation_entries_package_binding",
    );
    expect(persistenceMigrationSource).toContain(
      "fk_package_allocation_effect_intents_package_binding",
    );
    expect(persistenceMigrationSql).toContain(
      "target_kind = 'package' AND package_allocation_package_binding_id IS NOT NULL",
    );
    expect(persistenceMigrationSql).not.toContain(
      "target_kind = 'package' AND shipping_provider_label_id IS NOT NULL",
    );
    expect(persistenceMigrationSql).toContain(
      "shipping_provider_label_id IS NULL OR package_allocation_package_binding_id IS NOT NULL",
    );
    expect(persistenceMigrationSql).toContain(
      "COALESCE(package_allocation_package_binding_id, 0)",
    );

    expect(
      schemaSource.match(
        /packageAllocationPackageBindingId: bigint\("package_allocation_package_binding_id"/g,
      ),
    ).toHaveLength(2);
    expect(schemaSource).toContain(
      'name: "fk_package_allocation_entries_package_binding"',
    );
    expect(schemaSource).toContain(
      'name: "fk_package_allocation_effect_intents_package_binding"',
    );
    expect(schemaSource).toContain(
      "sql`COALESCE(${table.packageAllocationPackageBindingId}, 0)`",
    );
    expect(schemaSource).toContain(
      "${table.targetKind} = 'package'\n        AND ${table.packageAllocationPackageBindingId} IS NOT NULL",
    );
    expect(schemaSource).toContain(
      "${table.shippingProviderLabelId} IS NULL\n      OR ${table.packageAllocationPackageBindingId} IS NOT NULL",
    );
  });

  it("serializes membership and plan-child inserts against version advancement", () => {
    const membershipGuard = persistenceMigrationSource.match(
      /CREATE OR REPLACE FUNCTION wms\.guard_package_allocation_membership_insert\(\)[\s\S]*?\n\$\$;/,
    )?.[0];
    const planBuildGuard = persistenceMigrationSource.match(
      /CREATE OR REPLACE FUNCTION wms\.guard_package_allocation_plan_build\(\)[\s\S]*?\n\$\$;/,
    )?.[0];

    expect(membershipGuard).toContain("FOR UPDATE;");
    expect(membershipGuard).not.toContain("FOR KEY SHARE");
    expect(planBuildGuard).toContain("FOR UPDATE;");
    expect(planBuildGuard).not.toContain("FOR KEY SHARE");
  });

  it("removes only the repeated per-entry conservation scan", () => {
    expect(ledgerMigrationSource).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_package_allocation_groups_conservation[^\n]*\nDEFERRABLE INITIALLY DEFERRED/,
    );
    expect(ledgerMigrationSource).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_package_allocation_plans_conservation[^\n]*\nDEFERRABLE INITIALLY DEFERRED/,
    );
    expect(persistenceMigrationSql).toContain(
      "DROP TRIGGER trg_package_allocation_entries_conservation ON wms.package_allocation_entries",
    );
    expect(persistenceMigrationSource).not.toContain(
      "CREATE CONSTRAINT TRIGGER trg_package_allocation_entries_conservation",
    );
    expect(persistenceMigrationSource).not.toContain(
      "DROP TRIGGER trg_package_allocation_groups_conservation",
    );
    expect(persistenceMigrationSource).not.toContain(
      "DROP TRIGGER trg_package_allocation_plans_conservation",
    );
  });

  it("indexes the retained plan-level conservation lookup with Drizzle parity", () => {
    expect(persistenceMigrationSql).toContain(
      "CREATE INDEX idx_package_allocation_entries_plan_source_kind ON wms.package_allocation_entries ( package_allocation_plan_id, package_allocation_source_line_id, allocation_kind )",
    );
    expect(schemaSource).toMatch(
      /index\("idx_package_allocation_entries_plan_source_kind"\)\.on\(\s*table\.packageAllocationPlanId,\s*table\.packageAllocationSourceLineId,\s*table\.allocationKind,\s*\)/,
    );
  });

  it("uses the only migration 199 prefix", () => {
    const migrationFiles = readdirSync(join(process.cwd(), "migrations"));
    const migration199Files = migrationFiles
      .filter((file) => file.match(/^(\d+)_/)?.[1] === "199")
      .sort();

    expect(migration199Files).toEqual([
      "199_package_allocation_persistence_foundation.sql",
    ]);
  });
});
