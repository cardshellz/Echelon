import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
} from "../../package-allocation-authority-discovery.query";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function normalizedSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("package-allocation authority discovery query contract", () => {
  it("declares exactly the application relations read by the production query", () => {
    const discovered = new Set<string>();
    for (const match of PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL.matchAll(
      /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/gi,
    )) {
      discovered.add(match[1].toLowerCase());
    }
    expect([...discovered].sort()).toEqual(
      [...PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS].sort(),
    );
    expect(Object.isFrozen(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS))
      .toBe(true);
    expect(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES).toBe(200);
  });

  it("keeps the shared query read-only, parameterized, and bounded", () => {
    expect(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL).toContain(
      "shipment_item.id = ANY($1::integer[])",
    );
    expect(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL).toContain("LIMIT $2");
    expect(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
    );
  });

  it("matches every reviewed index in deployed migration 0619", () => {
    const migration = normalizedSql(fs.readFileSync(
      path.join(ROOT, "migrations", "0619_package_allocation_discovery_indexes.sql"),
      "utf8",
    ));
    const migrationIndexNames = [...migration.matchAll(/\bCREATE INDEX ([a-z0-9_]+)/gi)]
      .map((match) => match[1])
      .sort();
    expect(migrationIndexNames).toEqual(
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS
        .map((contract) => contract.indexName)
        .sort(),
    );
    for (const contract of PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS) {
      const expected = normalizedSql(
        `CREATE INDEX ${contract.indexName} ON wms.${contract.relationName} `
        + `(${contract.keyColumns.join(", ")}) `
        + `WHERE ${contract.predicateColumn} IS NOT NULL`,
      );
      expect(migration).toContain(expected);
    }
  });
});
