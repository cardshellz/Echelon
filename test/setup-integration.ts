/**
 * Shared named-schema integration test harness.
 *
 * These tests intentionally rebuild a small, current application schema. They
 * may only run against a database explicitly acknowledged as disposable.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { config } from "dotenv";
import pg from "pg";
import { describe } from "vitest";
import * as schema from "@shared/schema";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

export const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB
  ? describe.sequential
  : describe.skip;

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let schemaReady = false;

function requireDisposableDatabase(): string {
  if (!TEST_DB_URL) {
    throw new Error("ECHELON_TEST_DATABASE_URL is required for integration tests");
  }
  if (!DISPOSABLE_DB) {
    throw new Error(
      "Integration tests require ECHELON_TEST_DATABASE_DISPOSABLE=true",
    );
  }

  const protectedUrls = [
    process.env.DATABASE_URL,
    process.env.EXTERNAL_DATABASE_URL,
  ].filter((value): value is string => Boolean(value));
  if (protectedUrls.includes(TEST_DB_URL)) {
    throw new Error(
      "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
    );
  }

  return TEST_DB_URL;
}

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

export function getTestPool(): pg.Pool {
  if (!pool) {
    const connectionString = requireDisposableDatabase();
    pool = new pg.Pool({
      connectionString,
      max: 12,
      idleTimeoutMillis: 30_000,
      ssl: sslConfig(connectionString),
    });
  }
  return pool;
}

export function getTestDb() {
  if (!db) {
    db = drizzle(getTestPool(), { schema });
  }
  return db;
}

/**
 * Rebuild the test-owned schemas from a deliberately small current contract.
 * Kept under the historical name because the three integration suites already
 * call runMigrations().
 */
export async function runMigrations(): Promise<void> {
  if (schemaReady) return;

  requireDisposableDatabase();
  const bootstrapSql = readFileSync(
    resolve(process.cwd(), "test/fixtures/named-schema-integration.sql"),
    "utf8",
  );
  await getTestPool().query(bootstrapSql);
  schemaReady = true;
}

const TRUNCATE_TABLES = [
  "inventory.inventory_transactions",
  "inventory.inventory_levels",
  "wms.order_items",
  "wms.orders",
  "channels.allocation_audit_log",
  "channels.source_lock_config",
  "channels.channel_variant_overrides",
  "channels.channel_product_overrides",
  "channels.channel_allocation_rules",
  "channels.channel_warehouse_assignments",
  "channels.channel_product_lines",
  "channels.channel_product_allocation",
  "channels.channel_reservations",
  "channels.channels",
  "warehouse.warehouse_locations",
  "warehouse.warehouses",
  "catalog.product_line_products",
  "catalog.product_lines",
  "catalog.product_variants",
  "catalog.products",
];

export async function truncateTestData(): Promise<void> {
  if (!schemaReady) {
    throw new Error("runMigrations() must complete before test data is truncated");
  }
  await getTestDb().execute(sql.raw(
    `TRUNCATE TABLE ${TRUNCATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  ));
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
  pool = null;
  db = null;
  schemaReady = false;
}
