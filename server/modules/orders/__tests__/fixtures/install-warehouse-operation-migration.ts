import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { getTableColumns, SQL } from "drizzle-orm";
import * as schema from "@shared/schema";
import { operationOwnerTableFixture } from "./operation-owner-database";

const newColumns = [
  "operation_key",
  "operation_request_hash",
  "revision",
  "units_per_variant_snapshot",
  "execution_moved_base_units",
];
/** Add missing metadata to reduced legacy fixtures; preserve existing movement
 * tables, constraints and guards, then install the actual operation-owner DDL. */
export async function installWarehouseOperationMigration(
  pool: Pool,
  additionalTables: readonly PgTable[] = [],
) {
  for (const table of [
    schema.orders,
    schema.orderItems,
    schema.inventoryTransactions,
    schema.replenTasks,
    schema.pickingLogs,
    schema.auditEvents,
    schema.allocationExceptions,
    ...additionalTables,
  ] as PgTable[]) {
    const config = getTableConfig(table);
    const qualified = `${config.schema ?? "public"}.${config.name}`;
    const relation = (
      await pool.query("SELECT to_regclass($1) AS relation", [qualified])
    ).rows[0].relation;
    if (!relation) {
      await pool.query(operationOwnerTableFixture(table, newColumns));
      continue;
    }
    const names = new Set(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
          [config.schema ?? "public", config.name],
        )
      ).rows.map((row) => row.column_name),
    );
    for (const column of Object.values(getTableColumns(table))) {
      if (names.has(column.name) || newColumns.includes(column.name)) continue;
      const value = column.default;
      const defaultSql =
        value === undefined
          ? ""
          : ` DEFAULT ${value instanceof SQL ? new PgDialect().sqlToQuery(value).sql : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value)}`;
      await pool.query(
        `ALTER TABLE ${qualified} ADD COLUMN "${column.name}" ${column.getSQLType()}${defaultSql}`,
      );
    }
  }
  await pool.query(
    readFileSync("migrations/0719_warehouse_operation_owners.sql", "utf8"),
  );
  for (const file of [
    "136_financial_command_results.sql",
    "140_financial_command_operations.sql",
  ])
    await pool.query(readFileSync(`migrations/${file}`, "utf8"));
}
