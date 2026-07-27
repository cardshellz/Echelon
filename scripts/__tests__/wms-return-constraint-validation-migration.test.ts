import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "migrations/0600_validate_wms_return_constraints.sql",
);

function readMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf8");
}

describe("WMS return constraint validation migration", () => {
  it("validates the existing return lifecycle and quantity constraints", () => {
    const sql = readMigration();

    expect(sql).toContain("VALIDATE CONSTRAINT wms_returns_status_chk");
    expect(sql).toContain(
      "VALIDATE CONSTRAINT wms_return_items_quantity_chk",
    );
  });

  it("does not mutate rows or replace the existing constraints", () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/);
    expect(sql).not.toContain("ADD CONSTRAINT");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });
});
