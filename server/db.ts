import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
  );
}

// Always use SSL for external/production databases
// Heroku and most cloud databases require SSL connections
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

// Run startup migrations to ensure schema is up to date
export async function runStartupMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Create combined_order_groups table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS combined_order_groups (
        id SERIAL PRIMARY KEY,
        group_code VARCHAR(20),
        customer_name TEXT DEFAULT 'Unknown',
        customer_email TEXT,
        shipping_address TEXT,
        shipping_city TEXT,
        shipping_state TEXT,
        shipping_postal_code TEXT,
        shipping_country TEXT,
        address_hash VARCHAR(64),
        order_count INTEGER DEFAULT 0,
        total_items INTEGER DEFAULT 0,
        total_units INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_by VARCHAR,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Add any missing columns (safe to run multiple times with IF NOT EXISTS)
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS group_code VARCHAR(20)`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT 'Unknown'`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS customer_email TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_address TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_city TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_state TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_postal_code TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_country TEXT`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS order_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS total_items INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS total_units INTEGER DEFAULT 0`);
    console.log("Checked combined_order_groups table structure");

    // Add combined_group_id column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'orders' AND column_name = 'combined_group_id'
        ) THEN
          ALTER TABLE orders ADD COLUMN combined_group_id INTEGER REFERENCES combined_order_groups(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("Checked/added combined_group_id column");

    // Add combined_role column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'orders' AND column_name = 'combined_role'
        ) THEN
          ALTER TABLE orders ADD COLUMN combined_role TEXT;
        END IF;
      END $$;
    `);
    console.log("Checked/added combined_role column");
    
    // Migration 024: Channel allocation tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_product_allocation (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        channel_id integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        min_atp_base integer,
        max_atp_base integer,
        is_listed integer NOT NULL DEFAULT 1,
        notes text,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS channel_product_alloc_channel_product_idx
      ON channel_product_allocation(channel_id, product_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_sync_log (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        product_id integer REFERENCES products(id),
        product_variant_id integer REFERENCES product_variants(id),
        channel_id integer REFERENCES channels(id),
        channel_feed_id integer REFERENCES channel_feeds(id),
        atp_base integer NOT NULL,
        pushed_qty integer NOT NULL,
        previous_qty integer,
        status varchar(20) NOT NULL,
        error_message text,
        response_code integer,
        duration_ms integer,
        triggered_by varchar(30),
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("Checked channel_product_allocation and channel_sync_log tables");

    // Cleanup: delete zombie inventory_levels (all buckets zero, not assigned to bin)
    const zombieResult = await client.query(`
      DELETE FROM inventory_levels il
      WHERE il.variant_qty = 0
        AND il.reserved_qty = 0
        AND il.picked_qty = 0
        AND COALESCE(il.packed_qty, 0) = 0
        AND COALESCE(il.backorder_qty, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM product_locations pl
          WHERE pl.product_variant_id = il.product_variant_id
            AND pl.warehouse_location_id = il.warehouse_location_id
        )
    `);
    if (zombieResult.rowCount > 0) {
      console.log(`Cleaned up ${zombieResult.rowCount} zombie inventory_levels records`);
    }

  } catch (error) {
    console.error("Error running startup migrations:", error);
  } finally {
    client.release();
  }
}
