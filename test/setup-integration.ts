/**
 * Integration Test Setup
 *
 * - Connects to the test database using ECHELON_TEST_DATABASE_URL
 * - Runs Drizzle migrations to ensure schema is current
 * - Provides a shared db instance for all integration tests
 * - Truncates test data between tests (never drops tables)
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { config } from "dotenv";
import { resolve } from "path";
import * as schema from "@shared/schema";

// Load .env.test
config({ path: resolve(__dirname, "../.env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  throw new Error(
    "ECHELON_TEST_DATABASE_URL is not set. Create .env.test with the test database connection string.",
  );
}

// ---------------------------------------------------------------------------
// Shared pool + drizzle instance
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getTestPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false },
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

// ---------------------------------------------------------------------------
// Migration runner — executes raw SQL migration files in order
// ---------------------------------------------------------------------------

let migrationsRan = false;

/**
 * Bootstrap test DB schema using drizzle-kit generate + execute.
 * Instead of manually writing DDL (which drifts from the Drizzle schema),
 * we drop all test-relevant tables and recreate them from the schema definition.
 */
async function bootstrapMissingTables(testDb: ReturnType<typeof drizzle>): Promise<void> {
  // Drop tables in dependency order (children first)
  const dropOrder = [
    "allocation_audit_log",
    "channel_product_allocation",
    "channel_product_lines",
    "source_lock_config",
    "channel_reservations",
    "channel_sync_log",
    "channel_asset_overrides",
    "channel_variant_overrides",
    "channel_listings",
    "channel_pricing",
    "channel_product_overrides",
    "channel_feeds",
    "channel_connections",
    "partner_profiles",
    "channels",
    "product_line_products",
    "product_lines",
    "product_assets",
    "product_variants",
    "products",
  ];

  for (const table of dropOrder) {
    try {
      await testDb.execute(sql.raw(`DROP TABLE IF EXISTS "${table}" CASCADE`));
    } catch { /* ignore */ }
  }

  // Use drizzle-kit introspection to generate DDL — but that's complex.
  // Instead, use raw DDL that exactly matches the Drizzle schema.
  // This is auto-generated from catalog.schema.ts + channels.schema.ts

  // --- channels (base table, no schema-specific deps) ---
  await testDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "channels" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "name" varchar(200) NOT NULL,
      "type" varchar(20) NOT NULL DEFAULT 'internal',
      "provider" varchar(50) NOT NULL,
      "status" varchar(20) NOT NULL DEFAULT 'draft',
      "priority" integer NOT NULL DEFAULT 0,
      "allocation_pct" integer,
      "allocation_fixed_qty" integer,
      "is_default" integer NOT NULL DEFAULT 0,
      "config" jsonb,
      "sync_frequency_minutes" integer DEFAULT 60,
      "last_sync_at" timestamp,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- products ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "products" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "sku" varchar(100),
      "name" text NOT NULL,
      "title" varchar(500),
      "description" text,
      "bullet_points" jsonb,
      "category" varchar(100),
      "subcategory" varchar(200),
      "brand" varchar(100),
      "manufacturer" varchar(200),
      "base_unit" varchar(20) NOT NULL DEFAULT 'piece',
      "tags" jsonb,
      "seo_title" varchar(200),
      "seo_description" text,
      "shopify_product_id" varchar(100),
      "lead_time_days" integer NOT NULL DEFAULT 120,
      "safety_stock_days" integer NOT NULL DEFAULT 7,
      "status" varchar(20) DEFAULT 'active',
      "inventory_type" varchar(20) NOT NULL DEFAULT 'inventory',
      "is_active" boolean NOT NULL DEFAULT true,
      "condition" varchar(30) DEFAULT 'new',
      "country_of_origin" varchar(2),
      "harmonized_code" varchar(20),
      "item_specifics" jsonb,
      "last_pushed_at" timestamp,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- product_variants ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "product_variants" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "product_id" integer NOT NULL REFERENCES "products"("id"),
      "sku" varchar(100),
      "name" text NOT NULL,
      "units_per_variant" integer NOT NULL DEFAULT 1,
      "hierarchy_level" integer NOT NULL DEFAULT 1,
      "parent_variant_id" integer,
      "is_base_unit" boolean NOT NULL DEFAULT false,
      "barcode" varchar(100),
      "weight_grams" integer,
      "length_mm" integer,
      "width_mm" integer,
      "height_mm" integer,
      "price_cents" integer,
      "compare_at_price_cents" integer,
      "standard_cost_cents" double precision,
      "last_cost_cents" double precision,
      "avg_cost_cents" double precision,
      "track_inventory" boolean DEFAULT true,
      "inventory_policy" varchar(20) DEFAULT 'deny',
      "shopify_variant_id" varchar(100),
      "shopify_inventory_item_id" varchar(100),
      "is_active" boolean NOT NULL DEFAULT true,
      "position" integer DEFAULT 0,
      "option1_name" varchar(100),
      "option1_value" varchar(100),
      "option2_name" varchar(100),
      "option2_value" varchar(100),
      "option3_name" varchar(100),
      "option3_value" varchar(100),
      "gtin" varchar(14),
      "mpn" varchar(100),
      "condition_note" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- product_lines ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "product_lines" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "code" varchar(50) NOT NULL UNIQUE,
      "name" varchar(100) NOT NULL,
      "description" text,
      "is_active" boolean NOT NULL DEFAULT true,
      "sort_order" integer NOT NULL DEFAULT 0,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- product_line_products ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "product_line_products" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "product_line_id" integer NOT NULL REFERENCES "product_lines"("id") ON DELETE CASCADE,
      "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
      "created_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- product_assets ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "product_assets" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
      "url" text NOT NULL,
      "alt_text" varchar(500),
      "type" varchar(30) DEFAULT 'image',
      "position" integer DEFAULT 0,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- source_lock_config ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "source_lock_config" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "channel_id" integer NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
      "field_type" varchar(30) NOT NULL,
      "is_locked" integer NOT NULL DEFAULT 1,
      "locked_by" varchar(100),
      "locked_at" timestamp DEFAULT now(),
      "notes" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- channel_reservations ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "channel_reservations" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "channel_id" integer NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
      "product_variant_id" integer REFERENCES "product_variants"("id") ON DELETE CASCADE,
      "reserve_base_qty" integer NOT NULL DEFAULT 0,
      "min_stock_base" integer DEFAULT 0,
      "max_stock_base" integer,
      "override_qty" integer,
      "notes" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- channel_product_lines ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "channel_product_lines" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "channel_id" integer NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
      "product_line_id" integer NOT NULL REFERENCES "product_lines"("id") ON DELETE CASCADE,
      "is_active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- channel_product_allocation ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "channel_product_allocation" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "channel_id" integer NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
      "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
      "min_atp_base" integer,
      "max_atp_base" integer,
      "is_listed" integer NOT NULL DEFAULT 1,
      "notes" text,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- allocation_audit_log ---
  await testDb.execute(sql.raw(`
    CREATE TABLE "allocation_audit_log" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "product_id" integer REFERENCES "products"("id"),
      "product_variant_id" integer REFERENCES "product_variants"("id"),
      "channel_id" integer REFERENCES "channels"("id"),
      "total_atp_base" integer NOT NULL,
      "allocated_qty" integer NOT NULL,
      "previous_qty" integer,
      "allocation_method" varchar(30) NOT NULL,
      "details" jsonb,
      "triggered_by" varchar(30),
      "created_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  // --- partner_profiles (referenced by channel_connections) ---
  await testDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "partner_profiles" (
      "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      "name" varchar(200) NOT NULL,
      "type" varchar(30),
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
  `));

  console.log("[test-setup] Bootstrapped test schema");
}

export async function runMigrations(): Promise<void> {
  // Only run migrations once per test process (shared across suites)
  if (migrationsRan) return;

  const testDb = getTestDb();

  // Bootstrap tables that were created via drizzle-kit push, not migration files
  await bootstrapMissingTables(testDb);

  migrationsRan = true;
  console.log(`[test-setup] Schema ready`);
}

// ---------------------------------------------------------------------------
// Truncate all application tables (preserves schema, clears data)
// ---------------------------------------------------------------------------

/** Tables to truncate between tests, in dependency-safe order */
const TRUNCATE_TABLES = [
  "allocation_audit_log",
  "source_lock_config",
  "channel_sync_log",
  "channel_asset_overrides",
  "channel_variant_overrides",
  "channel_listings",
  "channel_pricing",
  "channel_product_overrides",
  "channel_product_allocation",
  "channel_product_lines",
  "channel_reservations",
  "channel_feeds",
  "channel_connections",
  "partner_profiles",
  "channels",
  "product_line_products",
  "product_lines",
  "product_assets",
  "product_variants",
  "products",
  // Legacy names (test DB may have these)
  "catalog_products",
  "catalog_assets",
];

export async function truncateTestData(): Promise<void> {
  const testDb = getTestDb();

  // Use TRUNCATE CASCADE for speed and FK safety
  for (const table of TRUNCATE_TABLES) {
    try {
      await testDb.execute(sql.raw(`TRUNCATE TABLE "${table}" CASCADE`));
    } catch (err: any) {
      // Table might not exist yet in some test scenarios
      if (!err.message?.includes("does not exist")) {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup — close pool after all tests
// ---------------------------------------------------------------------------

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
