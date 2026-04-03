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
      INSERT INTO catalog.product_lines (code, name, description, sort_order)
      VALUES ('TRADING_CARD_SUPPLIES', 'Trading Card Supplies', 'Card sleeves, toploaders, boxes, and accessories', 0)
      ON CONFLICT (code) DO NOTHING
    `);
    // Assign all existing products to default line (idempotent)
    await client.query(`
      INSERT INTO catalog.product_line_products (product_line_id, product_id)
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
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_levels_variant_location ON inventory_levels(product_variant_id, warehouse_location_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_order_id ON picking_logs(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_sku ON picking_logs(sku)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_picking_logs_timestamp ON picking_logs(timestamp)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product_variant_id ON inventory_transactions(product_variant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_transactions_order_id ON inventory_transactions(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_warehouse_status ON orders(warehouse_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_source_table_id ON orders(source_table_id)`);
    console.log("Checked performance indexes");

    // Migration: product_types reference table
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_types (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        slug VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    // Seed product types (idempotent)
    await client.query(`
      INSERT INTO catalog.product_types (slug, name, sort_order) VALUES
        ('toploaders', 'Toploaders', 1),
        ('easy-glide-sleeves', 'Easy Glide Soft Sleeves', 2),
        ('magnetic-holders', 'Magnetic Holders', 3),
        ('semi-rigids', 'Semi-Rigid Holders', 4),
        ('armalopes', 'Armalope Envelopes', 5),
        ('hero-cases', 'HERO Graded Card Cases', 6),
        ('binders', 'Binders & Pages', 7),
        ('storage-boxes', 'Storage Boxes (Quad Box, 400ct, etc.)', 8),
        ('glove-fit-toploader', 'Glove-Fit Toploader Sleeves', 9),
        ('glove-fit-mag', 'Glove-Fit Magnetic Holder Sleeves', 10),
        ('glove-fit-graded', 'Glove-Fit Graded Card Sleeves', 11),
        ('glove-fit-semi', 'Glove-Fit Semi-Rigid Sleeves', 12),
        ('sleeves-bags', 'Sleeves & Bags (team bags, 8x10, etc.)', 13),
        ('accessories', 'Accessories (mats, stamps, dividers, stands)', 14),
        ('wax', 'Wax/Sealed Products (boxes, packs)', 15),
        ('other', 'Other', 99)
      ON CONFLICT (slug) DO NOTHING
    `);
    // Add product_type column to products if missing
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(50)`);
    console.log("Checked product_types table and seeded data");

    // Migration: ebay_listing_rules table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay_listing_rules (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('default', 'product_type', 'sku')),
        scope_value VARCHAR(100),
        ebay_category_id VARCHAR(20),
        ebay_store_category_id VARCHAR(20),
        fulfillment_policy_id VARCHAR(20),
        return_policy_id VARCHAR(20),
        payment_policy_id VARCHAR(20),
        sort_order INTEGER DEFAULT 0,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(channel_id, scope_type, scope_value)
      )
    `);
    console.log("Checked ebay_listing_rules table");

    // Migration: ebay_category_mappings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay_category_mappings (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        product_type_slug VARCHAR(50) NOT NULL,
        ebay_browse_category_id VARCHAR(20),
        ebay_browse_category_name VARCHAR(200),
        ebay_store_category_id VARCHAR(20),
        ebay_store_category_name VARCHAR(200),
        fulfillment_policy_override VARCHAR(20),
        return_policy_override VARCHAR(20),
        payment_policy_override VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(channel_id, product_type_slug)
      )
    `);
    console.log("Checked ebay_category_mappings table");

    // Migration 045: OMS tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS oms_orders (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        external_order_id VARCHAR(100) NOT NULL,
        external_order_number VARCHAR(50),
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        financial_status VARCHAR(30) DEFAULT 'paid',
        fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
        customer_name VARCHAR(200),
        customer_email VARCHAR(200),
        customer_phone VARCHAR(50),
        ship_to_name VARCHAR(200),
        ship_to_address1 VARCHAR(300),
        ship_to_address2 VARCHAR(300),
        ship_to_city VARCHAR(100),
        ship_to_state VARCHAR(100),
        ship_to_zip VARCHAR(20),
        ship_to_country VARCHAR(10),
        subtotal_cents INTEGER NOT NULL DEFAULT 0,
        shipping_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        currency VARCHAR(3) NOT NULL DEFAULT 'USD',
        warehouse_id INTEGER REFERENCES warehouses(id),
        tracking_number VARCHAR(100),
        tracking_carrier VARCHAR(50),
        shipped_at TIMESTAMP,
        raw_payload JSONB,
        notes TEXT,
        tags TEXT,
        ordered_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(channel_id, external_order_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_status ON oms_orders(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_channel ON oms_orders(channel_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_ordered ON oms_orders(ordered_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_external ON oms_orders(external_order_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oms_order_lines (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
        product_variant_id INTEGER REFERENCES product_variants(id),
        external_line_item_id VARCHAR(100),
        sku VARCHAR(100),
        title VARCHAR(300),
        variant_title VARCHAR(200),
        quantity INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_lines_order ON oms_order_lines(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_lines_variant ON oms_order_lines(product_variant_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oms_order_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        details JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_events_order ON oms_order_events(order_id)`);
    console.log("Checked OMS tables (oms_orders, oms_order_lines, oms_order_events)");

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
    if ((zombieResult.rowCount ?? 0) > 0) {
      console.log(`Cleaned up ${zombieResult.rowCount} zombie inventory_levels records`);
    }

    // Migration: Sync Control System tables
    // 1. sync_settings — global sync engine config
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_settings (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        global_enabled BOOLEAN NOT NULL DEFAULT false,
        sweep_interval_minutes INTEGER NOT NULL DEFAULT 15,
        last_sweep_at TIMESTAMP,
        last_sweep_duration_ms INTEGER,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    // Insert default row if none exists
    await client.query(`
      INSERT INTO sync_settings (global_enabled, sweep_interval_minutes)
      SELECT true, 15
      WHERE NOT EXISTS (SELECT 1 FROM sync_settings)
    `);

    // 2. Per-channel sync settings (add columns to channels table)
    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS sync_mode VARCHAR(10) DEFAULT 'dry_run'`);
    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS sweep_interval_minutes INTEGER DEFAULT 15`);
    // Add CHECK constraint if not exists (safe to run multiple times)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'channels_sync_mode_check'
        ) THEN
          ALTER TABLE channels ADD CONSTRAINT channels_sync_mode_check
            CHECK (sync_mode IN ('live', 'dry_run'));
        END IF;
      END $$;
    `);

    // 3. Per-warehouse feed toggle
    await client.query(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS feed_enabled BOOLEAN DEFAULT true`);

    // 4. sync_log — unified activity log
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id INTEGER REFERENCES channels(id),
        channel_name VARCHAR(100),
        action VARCHAR(30) NOT NULL,
        sku VARCHAR(100),
        product_variant_id INTEGER,
        previous_value TEXT,
        new_value TEXT,
        status VARCHAR(20) NOT NULL,
        error_message TEXT,
        source VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_channel ON sync_log(channel_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log(status)`);
    console.log("Checked sync control system tables (sync_settings, sync_log, channel sync columns, warehouse feed_enabled)");

    // 5. ShipStation integration columns on oms_orders
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS shipstation_order_id INTEGER`);
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS shipstation_order_key VARCHAR(100)`);
    console.log("Checked ShipStation columns on oms_orders");

    // 6. eBay listing control columns
    await client.query(`ALTER TABLE ebay_category_mappings ADD COLUMN IF NOT EXISTS listing_enabled BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_listing_excluded BOOLEAN NOT NULL DEFAULT false`);
    console.log("Checked eBay listing control columns (listing_enabled, ebay_listing_excluded)");

    // 6b. Per-variant eBay listing exclusion
    await client.query(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_listing_excluded BOOLEAN NOT NULL DEFAULT false`);
    console.log("Checked per-variant eBay listing exclusion column");

    // 7. Per-product eBay browse category override columns
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_browse_category_id VARCHAR(20)`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_browse_category_name VARCHAR(200)`);
    console.log("Checked per-product eBay browse category override columns");

    // 8. eBay Item Specifics (Aspects) management tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay_category_aspects (
        id SERIAL PRIMARY KEY,
        category_id VARCHAR(20) NOT NULL,
        aspect_name VARCHAR(200) NOT NULL,
        aspect_required BOOLEAN NOT NULL DEFAULT false,
        aspect_mode VARCHAR(20) NOT NULL DEFAULT 'FREE_TEXT',
        aspect_usage VARCHAR(20) NOT NULL DEFAULT 'RECOMMENDED',
        aspect_values JSONB,
        aspect_order INT NOT NULL DEFAULT 0,
        fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(category_id, aspect_name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ebay_cat_aspects_cat ON ebay_category_aspects(category_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay_type_aspect_defaults (
        id SERIAL PRIMARY KEY,
        product_type_slug VARCHAR(100) NOT NULL,
        aspect_name VARCHAR(200) NOT NULL,
        aspect_value VARCHAR(500) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(product_type_slug, aspect_name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ebay_type_aspects_slug ON ebay_type_aspect_defaults(product_type_slug)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay_product_aspect_overrides (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        aspect_name VARCHAR(200) NOT NULL,
        aspect_value VARCHAR(500) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(product_id, aspect_name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ebay_prod_aspects_pid ON ebay_product_aspect_overrides(product_id)`);
    console.log("Checked eBay Item Specifics (aspects) tables");

    // Migration: channel_pricing_rules table for hierarchical pricing
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_pricing_rules (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER NOT NULL,
        scope VARCHAR(20) NOT NULL,
        scope_id VARCHAR(100),
        rule_type VARCHAR(20) NOT NULL,
        value NUMERIC(10,2) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // Unique constraint for non-null scope_id
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cpr_channel_scope_scopeid
      ON channel_pricing_rules(channel_id, scope, scope_id) WHERE scope_id IS NOT NULL
    `);
    // Unique constraint for null scope_id (channel-level rules)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cpr_channel_scope_null
      ON channel_pricing_rules(channel_id, scope) WHERE scope_id IS NULL
    `);
    console.log("Checked channel_pricing_rules table");

    // Migration: per-product and per-variant eBay policy overrides
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override VARCHAR(20)`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_return_policy_override VARCHAR(20)`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ebay_payment_policy_override VARCHAR(20)`);
    await client.query(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override VARCHAR(20)`);
    await client.query(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_return_policy_override VARCHAR(20)`);
    await client.query(`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS ebay_payment_policy_override VARCHAR(20)`);
    console.log("Checked eBay policy override columns on products + product_variants");

    // Migration: Make channel_allocation_rules.channel_id nullable for "All Channels" global rules
    await client.query(`ALTER TABLE channel_allocation_rules ALTER COLUMN channel_id DROP NOT NULL`);
    // Drop the old unique index that includes channel_id as NOT NULL and recreate with COALESCE
    // so NULL channel_id (global) rules are unique per product/variant
    await client.query(`DROP INDEX IF EXISTS car_channel_product_variant_idx`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS car_channel_product_variant_idx
      ON channel_allocation_rules(COALESCE(channel_id, 0), COALESCE(product_id, 0), COALESCE(product_variant_id, 0))
    `);
    console.log("Checked channel_allocation_rules nullable channel_id for global rules");

    // Migration 048: Add floor_type column for days-of-cover floor mode
    await client.query(`ALTER TABLE channel_allocation_rules ADD COLUMN IF NOT EXISTS floor_type VARCHAR(10) DEFAULT 'units'`);
    console.log("Checked channel_allocation_rules floor_type column");

    // Migration 049: Add source_name to shopify_orders for reconciliation job
    await client.query(`ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS source_name VARCHAR(100)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shopify_orders_source_name ON shopify_orders(source_name)`);
    console.log("Checked shopify_orders source_name column");

    // Migration 050: Dropship Platform — Phase 0 Foundation
    // dropship_vendors table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dropship_vendors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) NOT NULL UNIQUE,
        password_hash VARCHAR(200) NOT NULL,
        company_name VARCHAR(200),
        phone VARCHAR(50),
        shellz_club_member_id VARCHAR(255), -- Shellz Club member ID (external DB, no FK)
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        tier VARCHAR(20) DEFAULT 'standard',
        ebay_oauth_token TEXT,
        ebay_refresh_token TEXT,
        ebay_token_expires_at TIMESTAMP,
        ebay_user_id VARCHAR(200),
        stripe_customer_id VARCHAR(100),
        wallet_balance_cents INTEGER NOT NULL DEFAULT 0,
        auto_reload_enabled BOOLEAN DEFAULT false,
        auto_reload_threshold_cents INTEGER DEFAULT 5000,
        auto_reload_amount_cents INTEGER DEFAULT 20000,
        usdc_wallet_address VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dv_status ON dropship_vendors(status)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dv_member ON dropship_vendors(shellz_club_member_id) WHERE shellz_club_member_id IS NOT NULL`);

    // dropship_wallet_ledger table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dropship_wallet_ledger (
        id SERIAL PRIMARY KEY,
        vendor_id INTEGER NOT NULL REFERENCES dropship_vendors(id),
        type VARCHAR(30) NOT NULL,
        amount_cents INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        reference_type VARCHAR(50),
        reference_id VARCHAR(200),
        payment_method VARCHAR(30),
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dwl_vendor_id ON dropship_wallet_ledger(vendor_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dwl_vendor_created ON dropship_wallet_ledger(vendor_id, created_at DESC)`);

    // dropship_vendor_products table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dropship_vendor_products (
        id SERIAL PRIMARY KEY,
        vendor_id INTEGER NOT NULL REFERENCES dropship_vendors(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(vendor_id, product_id)
      )
    `);

    // Add dropship_eligible to products
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS dropship_eligible BOOLEAN DEFAULT false`);

    // Add vendor_id to orders and oms_orders
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_id INTEGER`);
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS vendor_id INTEGER`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_vendor ON oms_orders(vendor_id) WHERE vendor_id IS NOT NULL`);

    console.log("Checked dropship platform tables (dropship_vendors, dropship_wallet_ledger, dropship_vendor_products)");

    // ─── Migration 051: COGS Engine — FIFO cost tracking ──────────
    // Add COGS columns to inventory_lots
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_line_id INTEGER`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_unit_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS landed_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_unit_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_received INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_consumed INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS cost_source VARCHAR(20) DEFAULT 'manual'`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100)`);

    // Backfill existing lots: copy unit_cost_cents → COGS columns where not set
    await client.query(`
      UPDATE inventory_lots
      SET
        po_unit_cost_cents = COALESCE(unit_cost_cents, 0),
        total_unit_cost_cents = COALESCE(unit_cost_cents, 0),
        qty_received = COALESCE(qty_on_hand, 0) + COALESCE(qty_consumed, 0),
        cost_source = CASE
          WHEN purchase_order_id IS NOT NULL THEN 'po'
          ELSE 'manual'
        END
      WHERE COALESCE(total_unit_cost_cents, 0) = 0 AND COALESCE(unit_cost_cents, 0) > 0
    `);

    // order_line_costs table (COGS per order line)
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_line_costs (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        order_item_id INTEGER,
        product_variant_id INTEGER NOT NULL,
        lot_id INTEGER NOT NULL REFERENCES inventory_lots(id),
        qty_consumed INTEGER NOT NULL,
        unit_cost_cents NUMERIC(10,4) NOT NULL,
        total_cost_cents NUMERIC(10,4) NOT NULL,
        shipped_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_olc_order ON order_line_costs(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_olc_lot ON order_line_costs(lot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_olc_variant ON order_line_costs(product_variant_id)`);

    // cost_adjustment_log table (tracks cost changes)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cost_adjustment_log (
        id SERIAL PRIMARY KEY,
        lot_id INTEGER NOT NULL,
        lot_number VARCHAR(50),
        product_variant_id INTEGER,
        sku VARCHAR(100),
        old_cost_cents NUMERIC(10,4),
        new_cost_cents NUMERIC(10,4),
        delta_cents NUMERIC(10,4),
        reason VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cal_lot ON cost_adjustment_log(lot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cal_created ON cost_adjustment_log(created_at DESC)`);

    // FIFO indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_variant_fifo
      ON inventory_lots (product_variant_id, received_at ASC)
      WHERE status = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_shipment_cogs
      ON inventory_lots (inbound_shipment_id)
      WHERE inbound_shipment_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lots_cost_source
      ON inventory_lots (cost_source)
      WHERE status = 'active'
    `);

    console.log("Checked COGS engine tables (order_line_costs, cost_adjustment_log, inventory_lots COGS columns)");

    // ─── Migration 052: Subscription Engine — Native Shopify billing ──────────
    // Extend plans table
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_id BIGINT`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS shopify_selling_plan_gid VARCHAR(100)`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(20)`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS billing_interval_count INTEGER DEFAULT 1`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS price_cents INTEGER`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard'`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS includes_dropship BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE membership.plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);

    // Extend member_subscriptions table
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_id BIGINT`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS shopify_subscription_contract_gid VARCHAR(100)`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMP`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30) DEFAULT 'current'`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS failed_billing_attempts INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS billing_in_progress BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS payment_method_id VARCHAR(100)`);
    await client.query(`ALTER TABLE membership.member_subscriptions ADD COLUMN IF NOT EXISTS revision_id VARCHAR(50)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_shopify_contract ON membership.member_subscriptions(shopify_subscription_contract_id) WHERE shopify_subscription_contract_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ms_next_billing ON membership.member_subscriptions(next_billing_date) WHERE billing_status IN ('current', 'past_due') AND billing_in_progress = false`);

    // Extend members table
    await client.query(`ALTER TABLE membership.members ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT`);
    await client.query(`ALTER TABLE membership.members ADD COLUMN IF NOT EXISTS tier VARCHAR(30) DEFAULT 'standard'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_shopify_customer ON membership.members(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL`);

    // subscription_billing_log
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_billing_log (
        id SERIAL PRIMARY KEY,
        member_subscription_id INTEGER NOT NULL REFERENCES membership.member_subscriptions(id),
        shopify_billing_attempt_id VARCHAR(100),
        shopify_order_id BIGINT,
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD',
        status VARCHAR(30) NOT NULL,
        error_code VARCHAR(100),
        error_message TEXT,
        idempotency_key VARCHAR(200),
        billing_period_start TIMESTAMP,
        billing_period_end TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sbl_subscription ON subscription_billing_log(member_subscription_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sbl_status ON subscription_billing_log(status)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sbl_idempotency ON subscription_billing_log(idempotency_key) WHERE idempotency_key IS NOT NULL`);

    // subscription_events
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_events (
        id SERIAL PRIMARY KEY,
        member_subscription_id INTEGER REFERENCES membership.member_subscriptions(id),
        shopify_subscription_contract_id BIGINT,
        event_type VARCHAR(50) NOT NULL,
        event_source VARCHAR(30) NOT NULL,
        payload JSONB,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_se_subscription ON subscription_events(member_subscription_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_se_contract ON subscription_events(shopify_subscription_contract_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_se_type ON subscription_events(event_type)`);

    // selling_plan_map
    await client.query(`
      CREATE TABLE IF NOT EXISTS selling_plan_map (
        id SERIAL PRIMARY KEY,
        shopify_selling_plan_gid VARCHAR(100) NOT NULL UNIQUE,
        shopify_selling_plan_group_gid VARCHAR(100) NOT NULL,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        plan_name VARCHAR(100) NOT NULL,
        billing_interval VARCHAR(20) NOT NULL,
        price_cents INTEGER NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    console.log("Checked subscription engine tables (subscription_billing_log, subscription_events, selling_plan_map)");

    // ─── Migration 053: OMS Shopify webhook columns ──────────
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS financial_status VARCHAR(30) DEFAULT 'paid'`);
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`);
    await client.query(`ALTER TABLE oms_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP`);
    console.log("Checked OMS Shopify webhook columns (financial_status, cancelled_at, refunded_at)");

  } catch (error) {
    console.error("Error running startup migrations:", error);
  } finally {
    client.release();
  }
}
