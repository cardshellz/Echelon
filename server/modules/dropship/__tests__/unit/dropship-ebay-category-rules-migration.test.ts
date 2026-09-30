import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "0717_dropship_ebay_category_rules.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");

function tableBody(table: string): string {
  const start = migrationSql.indexOf(`CREATE TABLE ${table} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  return migrationSql.slice(start, migrationSql.indexOf(");\n", start));
}

describe("0717 dropship eBay category rules migration", () => {
  it("is the only migration with its number", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0717_"))).toEqual([MIGRATION_FILE]);
  });

  it("pins every revision to its vendor and store, and chains it to its predecessor", () => {
    const body = tableBody("dropship.dropship_ebay_category_rule_revisions");
    expect(body).toContain("UNIQUE (vendor_id, idempotency_key)");
    expect(body).toContain("UNIQUE (id, vendor_id, store_connection_id)");
    expect(body).toContain("FOREIGN KEY (store_connection_id, vendor_id) REFERENCES dropship.dropship_store_connections(id, vendor_id)");
    expect(body).toContain("FOREIGN KEY (previous_revision_id, vendor_id, store_connection_id)");
    expect(body).toContain("idempotency_key ~ '^[A-Za-z0-9:_-]+$'");
    expect(body).toContain("request_hash ~ '^[a-f0-9]{64}$'");
    expect(body).toContain("profile ? 'version' AND profile ? 'defaultCategory' AND profile ? 'rules'");
    expect(migrationSql).not.toContain("ON DELETE CASCADE");
  });

  it("keeps one head per store that can only point at the head's successor", () => {
    const body = tableBody("dropship.dropship_ebay_category_rule_profiles");
    expect(body).toContain("store_connection_id integer PRIMARY KEY");
    expect(body).toContain("REFERENCES dropship.dropship_ebay_category_rule_revisions(id, vendor_id, store_connection_id)");
    expect(migrationSql).toContain("CREATE TRIGGER ebay_category_rule_profile_coherence BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_ebay_category_rule_profiles");
    expect(migrationSql).toContain("IF predecessor IS DISTINCT FROM (SELECT revision_id FROM dropship.dropship_ebay_category_rule_profiles");
    expect(migrationSql).toContain("Reset eBay category rules with a new revision");
  });

  it("makes revisions immutable", () => {
    expect(migrationSql).toContain("CREATE TRIGGER ebay_category_rule_revision_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_ebay_category_rule_revisions");
    expect(migrationSql).toContain("eBay category rule revisions are immutable");
  });
});
