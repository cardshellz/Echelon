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

    // Add aisle_filter column to cycle_counts if missing
    await client.query(`ALTER TABLE cycle_counts ADD COLUMN IF NOT EXISTS aisle_filter VARCHAR(20)`);

    // Migration 037: Product lines
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_lines (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_line_products (
        id SERIAL PRIMARY KEY,
        product_line_id INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE(product_line_id, product_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_product_lines (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        product_line_id INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE(channel_id, product_line_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plp_product_id ON product_line_products(product_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plp_product_line_id ON product_line_products(product_line_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cpl_channel_id ON channel_product_lines(channel_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cpl_product_line_id ON channel_product_lines(product_line_id)`);
    // Seed default product line
    await client.query(`
      INSERT INTO product_lines (code, name, description, sort_order)
      VALUES ('TRADING_CARD_SUPPLIES', 'Trading Card Supplies', 'Card sleeves, toploaders, boxes, and accessories', 0)
      ON CONFLICT (code) DO NOTHING
    `);
    // Assign all existing products to default line (idempotent)
    await client.query(`
      INSERT INTO product_line_products (product_line_id, product_id)
      SELECT pl.id, p.id FROM product_lines pl, products p
      WHERE pl.code = 'TRADING_CARD_SUPPLIES'
        AND NOT EXISTS (SELECT 1 FROM product_line_products plp WHERE plp.product_line_id = pl.id AND plp.product_id = p.id)
    `);
    // Assign default line to all active channels (idempotent)
    await client.query(`
      INSERT INTO channel_product_lines (channel_id, product_line_id)
      SELECT c.id, pl.id FROM channels c, product_lines pl
      WHERE pl.code = 'TRADING_CARD_SUPPLIES' AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM channel_product_lines cpl WHERE cpl.channel_id = c.id AND cpl.product_line_id = pl.id)
    `);
    console.log("Checked product_lines tables and seeded defaults");

    // Add location_codes column to cycle_counts for quick single-bin counts
    await client.query(`ALTER TABLE cycle_counts ADD COLUMN IF NOT EXISTS location_codes TEXT`);

    // Migration 038: Make location code unique per warehouse instead of globally
    await client.query(`
      DO $$
      BEGIN
        -- Drop global unique constraint (may exist under either name)
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_locations_code_unique') THEN
          ALTER TABLE warehouse_locations DROP CONSTRAINT warehouse_locations_code_unique;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_locations_code_key') THEN
          ALTER TABLE warehouse_locations DROP CONSTRAINT warehouse_locations_code_key;
        END IF;
        -- Add composite unique (code + warehouse_id) if not already present
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_locations_code_warehouse_unique') THEN
          ALTER TABLE warehouse_locations ADD CONSTRAINT warehouse_locations_code_warehouse_unique UNIQUE (code, warehouse_id);
          RAISE NOTICE 'Migrated location code constraint to per-warehouse unique';
        END IF;
      END $$;
    `);

    // Performance indexes on high-traffic query columns
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(sku)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_product_variant_id ON inventory_levels(product_variant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_warehouse_location_id ON inventory_levels(warehouse_location_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_levels_pv_wl ON inventory_levels(product_variant_id, warehouse_location_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_order_id ON picking_logs(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_sku ON picking_logs(sku)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_timestamp ON picking_logs(timestamp)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product_variant_id ON inventory_transactions(product_variant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_order_id ON inventory_transactions(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_warehouse_status ON orders(warehouse_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_source_table_id ON orders(source_table_id)`);
    console.log("Checked performance indexes");

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
