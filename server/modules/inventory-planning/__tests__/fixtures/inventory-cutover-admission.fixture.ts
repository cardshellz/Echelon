import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import { INVENTORY_CUTOVER_CONFIGURATION_TABLES, INVENTORY_CUTOVER_OPERATIONAL_TABLES } from "../../domain/inventory-cutover-admission-fence";

/**
 * Minimal real PostgreSQL prerequisite tables for the actual admission migration.
 * Known columns use current Drizzle names/types, without recreating unrelated
 * business constraints. Existing full migration fixtures are preserved. The ten
 * SQL-only operational evidence tables need no business columns for a statement
 * admission trigger; their richer owner fixtures must be supplied by posting tests.
 * No fence function/trigger is stubbed here: callers execute actual migration236.
 */
export async function installCutoverAdmissionFixturePrerequisites(client: Pick<PoolClient, "query">): Promise<void> {
  const exportedValues: unknown[] = Object.values(schema);
  const definitions = new Map<string, ReturnType<typeof getTableConfig>>(exportedValues.filter((value): value is PgTable => is(value, PgTable))
    .map((table) => { const config = getTableConfig(table); return [`${config.schema ?? "public"}.${config.name}`, config] as const; }));
  const tables = [...INVENTORY_CUTOVER_CONFIGURATION_TABLES, ...INVENTORY_CUTOVER_OPERATIONAL_TABLES,
    "inventory.availability_runtime_authority", "inventory.availability_activation_freezes"];
  for (const table of tables) {
    const [namespace, name] = table.split(".");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(namespace)}`);
    const definition = definitions.get(table);
    const columns = definition?.columns.map((column) => ({ name: column.name, sqlType: column.getSQLType() }))
      ?? [{ name: "fixture_marker", sqlType: "integer" }];
    const qualified = `${identifier(namespace)}.${identifier(name)}`;
    await client.query(`CREATE TABLE IF NOT EXISTS ${qualified} (${columns.map((column) => `${identifier(column.name)} ${column.sqlType}`).join(",")})`);
    for (const column of columns) {
      await client.query(`ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS ${identifier(column.name)} ${column.sqlType}`);
    }
  }
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Invalid test schema identifier: ${value}`);
  return `"${value}"`;
}
