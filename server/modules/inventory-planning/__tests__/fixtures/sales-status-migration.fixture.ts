import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The sales status migration (inventory.sales_statuses and its history). The
 * publication target loader reads it for every product it plans, so every
 * reduced fixture whose suites plan or publish stock applies it, as they apply
 * the SKU-hold migration (0684) for the same reason. One constant, so the
 * PR-numbered filename is written once.
 */
export const SALES_STATUS_MIGRATION = "900000057000020130001_inventory_sales_statuses.sql";

export function salesStatusMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", SALES_STATUS_MIGRATION), "utf8");
}
