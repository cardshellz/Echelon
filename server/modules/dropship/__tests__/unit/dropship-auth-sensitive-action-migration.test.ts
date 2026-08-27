import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dropshipSensitiveActionEnum as schemaSensitiveActions } from "../../../../../shared/schema/dropship.schema";
import { dropshipSensitiveActionEnum as domainSensitiveActions } from "../../domain/auth";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/212_dropship_catalog_selection_sensitive_action.sql"),
  "utf8",
);

function extractMigrationConstraintActions(sql: string): string[] {
  const constraint = sql.match(
    /ADD CONSTRAINT dropship_sensitive_challenge_action_chk\s+CHECK \(action IN \(([\s\S]*?)\)\);/,
  );
  if (!constraint) {
    throw new Error("Sensitive-action constraint definition is missing from migration 212.");
  }

  return Array.from(constraint[1].matchAll(/'([^']+)'/g), (match) => match[1]);
}

describe("212_dropship_catalog_selection_sensitive_action migration", () => {
  it("keeps domain, shared schema, and database challenge actions in exact parity", () => {
    expect(schemaSensitiveActions).toEqual(domainSensitiveActions);
    expect(extractMigrationConstraintActions(migrationSql)).toEqual(domainSensitiveActions);
    expect(domainSensitiveActions).toContain("manage_catalog_selection");
  });

  it("replaces only the sensitive-action check constraint", () => {
    expect(migrationSql).toContain(
      "DROP CONSTRAINT IF EXISTS dropship_sensitive_challenge_action_chk",
    );
    expect(migrationSql).not.toMatch(/\b(?:DROP|TRUNCATE)\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\b(?:DELETE|UPDATE)\s+(?:FROM\s+)?dropship\./i);
  });
});
