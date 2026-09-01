import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8")
    .replace(/\r\n/g, "\n");
}

const migration = source(
  "migrations",
  "0634_package_allocation_authority_snapshot.sql",
);
const schema = source("shared", "schema", "fulfillment.schema.ts");
const normalizedMigration = migration.replace(/\s+/g, " ").trim();

describe("package allocation authority snapshot migration contract", () => {
  it("backfills every existing plan before making provenance mandatory", () => {
    expect(normalizedMigration).toContain(
      "ALTER TABLE wms.package_allocation_plans ADD COLUMN authority_snapshot JSONB",
    );
    expect(normalizedMigration).toContain(
      "UPDATE wms.package_allocation_plans SET authority_snapshot = jsonb_build_object(",
    );
    expect(normalizedMigration).toContain(
      "WHERE authority_snapshot IS NULL",
    );
    expect(normalizedMigration.indexOf("UPDATE wms.package_allocation_plans"))
      .toBeLessThan(normalizedMigration.indexOf(
        "ALTER COLUMN authority_snapshot SET NOT NULL",
      ));
    expect(normalizedMigration).toContain(
      "'selectionAuthority', 'caller_supplied_unproven'",
    );
    expect(normalizedMigration).toContain(
      "'selectionCompleteness', 'unproven_caller_selection'",
    );
  });

  it("requires every immutable plan snapshot to remain a JSON object", () => {
    expect(normalizedMigration).toContain(
      "DROP CONSTRAINT package_allocation_plans_snapshots_chk",
    );
    expect(normalizedMigration).toContain(
      "jsonb_typeof(authority_snapshot) = 'object'",
    );
    expect(schema).toContain(
      'authoritySnapshot: jsonb("authority_snapshot").notNull()',
    );
    expect(schema).toContain(
      "jsonb_typeof(${table.authoritySnapshot}) = 'object'",
    );
  });
});
