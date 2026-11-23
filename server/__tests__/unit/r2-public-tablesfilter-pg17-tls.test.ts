import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

function walkNonTestServerTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test" || entry.name === "node_modules") {
        continue;
      }
      results.push(...walkNonTestServerTs(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Exact replica of drizzle-kit's `pgPushIntrospect` bare-table-name filter
 * (`node_modules/drizzle-kit/bin.cjs`) for exact or negated (`!name`) patterns.
 */
function evaluateDrizzleTablesFilter(
  tablesFilter: readonly string[],
  bareTableName: string,
): boolean {
  if (tablesFilter.length === 0) return true;
  const flags: boolean[] = [];
  for (const pattern of tablesFilter) {
    const isNegated = pattern.startsWith("!");
    const target = isNegated ? pattern.slice(1) : pattern;
    const matches = isNegated ? bareTableName !== target : bareTableName === target;
    if (isNegated && !matches) {
      flags.push(false);
    }
    if (matches) {
      flags.push(true);
    }
  }
  return flags.length > 0 ? flags.every(Boolean) : false;
}

describe("Batch R-2: public schema tablesFilter, PostgreSQL 17 CI alignment, and TLS ratchet (P4.1, P4.5)", () => {
  it("configures drizzle.config.ts schemaFilter and tablesFilter safely without bare-name collisions (P4.1)", async () => {
    const previousDbUrl = process.env.DATABASE_URL;
    if (!previousDbUrl) {
      process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/echelon_test";
    }

    try {
      const mod = await import("../../../drizzle.config");
      const config = mod.default as {
        schemaFilter?: string[];
        tablesFilter?: string[];
      };

      const schemaFilter = config.schemaFilter ?? [];
      const tablesFilter = config.tablesFilter ?? [];

      expect(schemaFilter).not.toContain("membership");
      expect(schemaFilter).not.toContain("drizzle");
      expect(schemaFilter).toEqual(
        expect.arrayContaining([
          "public",
          "wms",
          "oms",
          "inventory",
          "catalog",
          "procurement",
          "channels",
          "warehouse",
          "dropship",
          "ebay",
          "identity",
          "shipping",
          "shopify",
          "marketplace",
          "notifications",
          "operations",
          "returns",
        ]),
      );

      for (const pattern of tablesFilter) {
        expect(pattern).toMatch(/^![a-z0-9_]+$/);
      }

      const baselineSql = readRepoFile("migrations/baseline/schema.sql");
      const allBaselineTables = [
        ...baselineSql.matchAll(/CREATE TABLE ([a-z_]+)\.([a-zA-Z0-9_]+)\s*\(/g),
      ].map((m) => ({ schema: m[1]!, name: m[2]! }));

      // 1. Every table in every Echelon non-public schema must pass tablesFilter (0 bare-name collisions)
      const echelonNonPublicSchemas = new Set(schemaFilter.filter((s) => s !== "public"));
      const nonPublicCollisions = allBaselineTables
        .filter((t) => echelonNonPublicSchemas.has(t.schema))
        .filter((t) => !evaluateDrizzleTablesFilter(tablesFilter, t.name));
      expect(nonPublicCollisions).toEqual([]);

      // 2. Every Drizzle-declared public.* table in shared/schema must pass tablesFilter
      for (const drizzleDeclaredPublic of [
        "audit_events",
        "financial_command_recoveries",
        "financial_command_results",
        "idempotency_keys",
        "shopify_variants",
        "auto_draft_runs",
        "reorder_exclusion_rules",
      ]) {
        expect(
          evaluateDrizzleTablesFilter(tablesFilter, drizzleDeclaredPublic),
          drizzleDeclaredPublic,
        ).toBe(true);
      }

      // 3. Every non-colliding shellz_club, SQL-managed, and retired shadow public.* table is excluded
      for (const protectedPublic of [
        "_migrations",
        "scheduler_runs",
        "__cardshellz_manual_migrations",
        "__drizzle_migrations",
        "background_jobs",
        "discounts",
        "pricing_rules",
        "shopify_order_items",
        "shopify_orders",
        "shopify_products",
        "catalog_assets",
        "catalog_products",
        "dropship_vendor_products",
        "inventory_items",
        "startup_inventory_anomalies",
        "uom_variants",
      ]) {
        expect(
          evaluateDrizzleTablesFilter(tablesFilter, protectedPublic),
          protectedPublic,
        ).toBe(false);
      }
    } finally {
      if (previousDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDbUrl;
      }
    }
  });

  it("reconciles 100% of baseline public.* tables in DB-ROLE-SEPARATION-RUNBOOK.md §2b (P4.1)", () => {
    const baselineSql = readRepoFile("migrations/baseline/schema.sql");
    const baselinePublicTables = [
      ...baselineSql.matchAll(/CREATE TABLE public\.([a-zA-Z0-9_]+)\s*\(/g),
    ]
      .map((m) => m[1]!)
      .sort();

    expect(baselinePublicTables).toHaveLength(33);

    const shellzTransferred = [
      "__cardshellz_manual_migrations",
      "__drizzle_migrations",
      "app_settings",
      "auto_draft_runs",
      "background_jobs",
      "reorder_exclusion_rules",
      "shopify_collections",
      "shopify_order_items",
      "shopify_orders",
      "shopify_products",
      "shopify_variants",
    ];
    const echelonActivePublic = [
      "_migrations",
      "audit_events",
      "financial_command_recoveries",
      "financial_command_results",
      "idempotency_keys",
      "scheduler_runs",
    ];
    const echelonRetiredShadow = [
      "adjustment_reasons",
      "auth_permissions",
      "auth_role_permissions",
      "auth_roles",
      "catalog_assets",
      "catalog_products",
      "channel_pricing_rules",
      "channels",
      "dropship_vendor_products",
      "dropship_vendors",
      "inventory_items",
      "order_line_costs",
      "startup_inventory_anomalies",
      "sync_settings",
      "uom_variants",
      "users",
    ];

    const union = [
      ...shellzTransferred,
      ...echelonActivePublic,
      ...echelonRetiredShadow,
    ].sort();
    expect(new Set(union).size).toBe(33);
    expect(union).toEqual(baselinePublicTables);

    const runbook = readRepoFile("DB-ROLE-SEPARATION-RUNBOOK.md");
    for (const tableName of baselinePublicTables) {
      expect(runbook, `runbook documents public.${tableName}`).toContain(tableName);
    }

    // Extract the §2b FOREACH array and verify it transfers strictly the 11 live shellz_club public tables
    const section2bMatch = runbook.match(
      /2b\.[\s\S]*?FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/,
    );
    expect(section2bMatch).not.toBeNull();
    const sqlList = [...section2bMatch![1]!.matchAll(/'([a-z0-9_]+)'/g)]
      .map((m) => m[1]!)
      .sort();
    expect(sqlList).toEqual([...shellzTransferred].sort());
  });

  it("aligns all GitHub Actions workflows and docker-compose.test.yml on PostgreSQL 17 (P4.1)", () => {
    const workflowDir = path.join(REPO_ROOT, ".github/workflows");
    const workflowFiles = fs
      .readdirSync(workflowDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

    for (const wf of workflowFiles) {
      const content = readRepoFile(`.github/workflows/${wf}`);
      expect(content, `${wf} should not use postgres:16`).not.toContain("postgres:16");
    }

    expect(readRepoFile(".github/workflows/ci.yml").match(/image: postgres:17\n/g)).toHaveLength(2);
    expect(readRepoFile(".github/workflows/procurement-connected.yml")).toContain("image: postgres:17");
    expect(readRepoFile(".github/workflows/returns-preview.yml")).toContain("image: postgres:17");
    expect(readRepoFile(".github/workflows/schema-drift.yml").match(/image: postgres:17\n/g)).toHaveLength(2);
    expect(readRepoFile("docker-compose.test.yml")).toContain("image: postgres:17-alpine");
  });

  it("eliminates hardcoded rejectUnauthorized: false across production server/ and publish-production-structure.ts (P4.5)", () => {
    const publishScript = readRepoFile("scripts/publish-production-structure.ts");
    expect(publishScript).toContain("resolvePostgresPoolSslConfig");
    expect(publishScript).not.toContain("rejectUnauthorized: false");

    const allowedPoolConfig = path
      .join(REPO_ROOT, "server/database-pool-config.ts")
      .replace(/\\/g, "/");
    const violations: string[] = [];

    for (const filePath of walkNonTestServerTs(path.join(REPO_ROOT, "server"))) {
      const normalized = filePath.replace(/\\/g, "/");
      if (normalized === allowedPoolConfig) continue;
      const text = fs.readFileSync(filePath, "utf8");
      if (text.includes("rejectUnauthorized: false")) {
        violations.push(path.relative(REPO_ROOT, filePath).replace(/\\/g, "/"));
      }
    }

    expect(violations).toEqual([]);
  });
});
