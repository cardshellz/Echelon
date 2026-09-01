import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  demandEvidenceSnapshots,
  fulfillmentNodeProviderBindings,
  fulfillmentNodes,
  fulfillmentProviderAccounts,
  fulfillmentProviderLocations,
  locationPromisePolicyHeads,
  locationPromisePolicyVersions,
  promiseSafetyPolicyHeads,
  promiseSafetyPolicyVersions,
  transformationModelHeads,
  transformationModelPaths,
  transformationModelReviews,
  transformationModelVersions,
  transformationRecipeBindings,
  transformationRecipeComponentSnapshots,
} from "../../../../../shared/schema/inventory-planning.schema";

const MIGRATION_PREFIX = "211";
const MIGRATION_FILENAME = "211_inventory_availability_foundation.sql";
const migrationPath = resolve(process.cwd(), "migrations", MIGRATION_FILENAME);
const migrationSql = readFileSync(migrationPath, "utf8");
const phase3MigrationSql = readFileSync(
  resolve(process.cwd(), "migrations", "0622_inventory_availability_backfill_review.sql"),
  "utf8",
);
const provenanceRefreshMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations", "0628_inventory_backfill_provenance_refresh.sql"),
  "utf8",
);
const parityMigrationSql = [
  migrationSql,
  phase3MigrationSql,
  provenanceRefreshMigrationSql,
].join("\n");
const compactMigrationSql = migrationSql.replace(/\s+/g, " ").trim();
const schemaPath = resolve(process.cwd(), "shared/schema/inventory-planning.schema.ts");
const schemaSource = readFileSync(schemaPath, "utf8");
const compactSchemaSource = schemaSource.replace(/\s+/g, " ").trim();

const parityTables: readonly PgTable[] = [
  fulfillmentNodes,
  fulfillmentProviderAccounts,
  fulfillmentProviderLocations,
  fulfillmentNodeProviderBindings,
  locationPromisePolicyVersions,
  locationPromisePolicyHeads,
  transformationModelVersions,
  transformationModelPaths,
  transformationRecipeBindings,
  transformationRecipeComponentSnapshots,
  transformationModelHeads,
  transformationModelReviews,
  promiseSafetyPolicyVersions,
  promiseSafetyPolicyHeads,
  demandEvidenceSnapshots,
];

function extractCreateTableBody(schemaName: string, tableName: string): string {
  const header = `CREATE TABLE ${schemaName}.${tableName} (`;
  const headerIndex = parityMigrationSql.indexOf(header);
  if (headerIndex < 0) throw new Error(`Missing ${schemaName}.${tableName}`);
  const bodyStart = headerIndex + header.length;
  let depth = 1;
  let insideString = false;
  for (let index = bodyStart; index < parityMigrationSql.length; index += 1) {
    const character = parityMigrationSql[index];
    const nextCharacter = parityMigrationSql[index + 1];
    if (character === "'") {
      if (insideString && nextCharacter === "'") {
        index += 1;
        continue;
      }
      insideString = !insideString;
      continue;
    }
    if (insideString) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return parityMigrationSql.slice(bodyStart, index);
    }
  }
  throw new Error(`Unterminated ${schemaName}.${tableName}`);
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let insideString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (character === "'") {
      if (insideString && nextCharacter === "'") {
        index += 1;
        continue;
      }
      insideString = !insideString;
      continue;
    }
    if (insideString) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function migrationColumns(schemaName: string, tableName: string): string[] {
  const createColumns = splitTopLevel(extractCreateTableBody(schemaName, tableName))
    .filter((part) => !/^CONSTRAINT\b/i.test(part))
    .map((part) => part.match(/^([a-z_][a-z0-9_]*)\s/i)?.[1])
    .filter((column): column is string => Boolean(column));
  const qualifiedName = `${schemaName}.${tableName}`.replace(".", "\\.");
  const alterPattern = new RegExp(
    `ALTER\\s+TABLE\\s+${qualifiedName}([\\s\\S]*?);`,
    "gi",
  );
  const addedColumns = [...parityMigrationSql.matchAll(alterPattern)]
    .flatMap((match) => [...match[1].matchAll(/\bADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)])
    .map((match) => match[1]);
  return [...new Set([...createColumns, ...addedColumns])].sort();
}

function configuredObjectNames(table: PgTable): Set<string> {
  const config = getTableConfig(table);
  return new Set([
    ...config.checks.map((constraint) => constraint.name),
    ...config.foreignKeys.map((foreignKey) => foreignKey.getName()),
    ...config.indexes
      .map((index) => index.config.name)
      .filter((name): name is string => name !== undefined),
    ...config.uniqueConstraints.map((constraint) => constraint.name),
  ]);
}

function migrationNamedObjects(schemaName: string, tableName: string): string[] {
  const bodyNames = [...extractCreateTableBody(schemaName, tableName)
    .matchAll(/\bCONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[1]);
  const qualifiedName = `${schemaName}.${tableName}`.replace(".", "\\.");
  const indexPattern = new RegExp(
    `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+([a-z_][a-z0-9_]*)\\s+ON\\s+${qualifiedName}\\b`,
    "gi",
  );
  const alterPattern = new RegExp(
    `\\bALTER\\s+TABLE\\s+${qualifiedName}\\s+ADD\\s+CONSTRAINT\\s+([a-z_][a-z0-9_]*)`,
    "gi",
  );
  return [
    ...bodyNames,
    ...[...parityMigrationSql.matchAll(indexPattern)].map((match) => match[1]),
    ...[...parityMigrationSql.matchAll(alterPattern)].map((match) => match[1]),
  ].sort();
}

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolutePath));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) result.push(absolutePath);
  }
  return result;
}

function extractMigrationFunction(functionName: string): string {
  const header = `CREATE OR REPLACE FUNCTION ${functionName}()`;
  const start = migrationSql.indexOf(header);
  if (start < 0) throw new Error(`Missing ${functionName}`);
  const end = migrationSql.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`Unterminated ${functionName}`);
  return migrationSql.slice(start, end + 4);
}

describe("inventory availability Slice 1 migration contract", () => {
  it("is additive, empty, and has no runtime authority tables", () => {
    const definitionSection = migrationSql.slice(0, migrationSql.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(definitionSection).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(definitionSection).not.toMatch(/\bUPDATE\s+(?:catalog|warehouse|inventory|wms|channels)\./i);
    expect(definitionSection).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\binventory\.atp_(?:claims|activation|runtime|shadow|publication)/i);
    expect(migrationSql).not.toContain("wms.fulfillment_groups");
    expect(migrationSql).toContain("it creates no claim, activation, runtime-binding, or publication authority");
  });

  it("declares exactly the same 15 tables and columns across additive SQL and Drizzle", () => {
    const expectedNames = parityTables.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }).sort();
    const migrationNames = [...parityMigrationSql.matchAll(/\bCREATE\s+TABLE\s+([a-z_]+\.[a-z_]+)/gi)]
      .map((match) => match[1])
      .sort();
    expect(migrationNames).toEqual(expectedNames);

    for (const table of parityTables) {
      const config = getTableConfig(table);
      expect(
        config.columns.map((column) => column.name).sort(),
        `${config.schema}.${config.name}`,
      ).toEqual(migrationColumns(config.schema!, config.name));
    }
  });

  it("represents every named SQL constraint and index in Drizzle", () => {
    for (const table of parityTables) {
      const config = getTableConfig(table);
      const configured = configuredObjectNames(table);
      for (const objectName of migrationNamedObjects(config.schema!, config.name)) {
        expect(
          configured.has(objectName),
          `${config.schema}.${config.name} is missing ${objectName}`,
        ).toBe(true);
      }
    }
  });

  it("serializes provider identity lifecycle and enforces exact 3PL binding state", () => {
    expect(compactMigrationSql).toContain(
      "Families: provider account -> provider location -> fulfillment node.",
    );
    for (const namespace of ["918411", "918412", "918413"]) {
      expect(migrationSql).toContain(`pg_advisory_xact_lock(${namespace}, lock_id)`);
    }
    expect(migrationSql).toContain("FOR KEY SHARE;");
    expect(migrationSql).toContain("retired fulfillment node % retains active provider bindings");
    expect(migrationSql).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("keeps draft definitions editable but sealed definitions immutable and owner-serialized", () => {
    expect(migrationSql).toContain("old_status = 'draft' AND new_status = 'draft'");
    expect(migrationSql).toContain("sealed definitions are append-only");
    expect(migrationSql).toContain("heads cannot be deleted");
    expect(migrationSql).toContain("revision must advance exactly once");
    for (const namespace of ["918421", "918422", "918423"]) {
      expect(migrationSql).toMatch(new RegExp(`pg_advisory_xact_lock\\(\\s*${namespace}\\b`));
    }
    const memberGuard = migrationSql.slice(
      migrationSql.indexOf("CREATE OR REPLACE FUNCTION inventory.guard_transformation_member_write"),
      migrationSql.indexOf("CREATE TRIGGER transformation_model_paths_write_guard"),
    );
    expect(memberGuard).toContain("FOR NO KEY UPDATE");
    expect(memberGuard).not.toContain("pg_advisory_xact_lock");
    expect(memberGuard).not.toMatch(/TG_OP\s*=\s*'UPDATE'\s+AND\s+NEW\./i);
  });

  it("normalizes heterogeneous trigger rows before reading table-specific fields", () => {
    const polymorphicFunctions = [
      "warehouse.guard_fulfillment_identity_write",
      "warehouse.assert_fulfillment_node_binding_coherence",
      "inventory.assert_version_predecessor",
      "inventory.guard_versioned_definition_update",
      "inventory.guard_definition_head_write",
      "inventory.assert_definition_head_coherence",
    ];

    for (const functionName of polymorphicFunctions) {
      const functionSql = extractMigrationFunction(functionName);
      expect(functionSql, functionName).toContain("to_jsonb(");
      expect(functionSql, functionName).not.toMatch(/\b(?:NEW|OLD)\.[a-z_][a-z0-9_]*/i);
    }
  });

  it("stores explicit directed paths and immutable complete recipe snapshots", () => {
    expect(migrationSql).toContain("CREATE TABLE inventory.transformation_model_paths");
    expect(compactMigrationSql).toContain(
      "authority_state = 'blocked' OR input_qty::bigint * source_units_per_variant::bigint = output_qty::bigint * destination_units_per_variant::bigint",
    );
    expect(migrationSql).toContain("transformation_model_paths_recipe_binding_fk");
    expect(migrationSql).toContain("CREATE TABLE inventory.transformation_recipe_component_snapshots");
    expect(migrationSql).toContain("component_units_per_variant, component_qty");
    expect(compactMigrationSql).toContain(
      "SELECT count(*) FROM inventory.build_recipe_components AS component",
    );
    expect(migrationSql).toContain("new_build_to_promise_enabled");
    expect(migrationSql).toContain("binding.relationship_role = 'component_build'");
    expect(migrationSql).toContain("A reverse conversion requires a separate row");
    expect(migrationSql).not.toMatch(/equivalence_(?:group|member|relationship)/i);
  });

  it("defines independent location eligibility, safety policy, and append-only demand evidence", () => {
    expect(migrationSql).toContain("eligibility_mode IN ('inherit', 'eligible', 'ineligible')");
    expect(migrationSql).toContain("policy_mode IN ('inherit', 'off', 'fixed_units', 'days_of_cover')");
    expect(compactMigrationSql).toContain("scope_type = 'network_variant'");
    expect(compactSchemaSource).toContain("${table.scopeType} = 'network_variant'");
    expect(migrationSql).toContain("daily_demand_milli_units bigint");
    expect(migrationSql).toContain("demand evidence snapshots are append-only");
    expect(migrationSql).toContain("demand_evidence_snapshots_input_uq");
    expect(compactSchemaSource).toContain("table.calculatedAt.desc(), table.id.desc()");
  });

  it("reserves the only 211 migration prefix", () => {
    const matching = readdirSync(join(process.cwd(), "migrations"))
      .filter((file) => file.match(/^(\d+)_/)?.[1] === MIGRATION_PREFIX)
      .sort();
    expect(matching).toEqual([MIGRATION_FILENAME]);
  });

  it("keeps current production paths disconnected from the inactive schema", () => {
    const forbidden = [
      "inventory-planning.schema",
      "inventory.transformation_model_heads",
      "inventory.promise_safety_policy_heads",
      "inventory.location_promise_policy_heads",
      "warehouse.fulfillment_nodes",
    ];
    const roots = [resolve(process.cwd(), "server"), resolve(process.cwd(), "client/src")];
    for (const root of roots) {
      if (!statSync(root).isDirectory()) continue;
      for (const file of sourceFiles(root)) {
        if (
          file.includes(`${sep}__tests__${sep}`)
          || file.includes(`${sep}modules${sep}inventory-planning${sep}`)
        ) continue;
        const source = readFileSync(file, "utf8");
        for (const symbol of forbidden) {
          expect(source, `${relative(process.cwd(), file)} reads ${symbol}`).not.toContain(symbol);
        }
      }
    }
  });
});
