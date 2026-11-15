import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";
import { createDatabasePoolConfig } from "./database-pool-config";
import { boundStartupMigrationClient } from "./startup-migration-guard";
import { CHANNEL_PRICING_RULES_DDL } from "./modules/channels/infrastructure/channel-pricing-schema";
import {
  getPostgresPoolSnapshot,
  type PostgresPoolSnapshot,
} from "./infrastructure/postgres-pool-observability";

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString && !process.env.VITEST) {
  throw new Error(
    "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
  );
}

// Always use SSL for external/production databases
// Heroku and most cloud databases require SSL connections
const useSSL = process.env.EXTERNAL_DATABASE_URL || (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("amazonaws.com"));

// In test environments without a DB connection, create a stub pool so
// modules that import db.ts don't crash at load time. Actual DB calls
// will fail at runtime (tests should mock them).
const poolConfig = createDatabasePoolConfig({
  connectionString: connectionString || "postgresql://stub:stub@localhost:5432/stub",
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  // Pool size per process. The old max:3 throttled the app to 3 connections and made
  // the reconcile sweep saturate and throw "timeout exceeded when trying to connect"
  // (the pool-acquire timeout). Heroku PG allows 200 (≈19 in use, single web dyno), so
  // there's ample headroom. Env-overridable (PG_POOL_MAX) for tuning; default 20.
  max: connectionString ? (Number(process.env.PG_POOL_MAX) || 20) : 0,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const pool = new Pool(poolConfig);

export function getDatabasePoolSnapshot(): PostgresPoolSnapshot {
  return getPostgresPoolSnapshot({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    options: { max: poolConfig.max },
  });
}

pool.on("error", (error) => {
  console.error("[DatabasePool] Unexpected idle client error:", error);
});

/**
 * A small pool of its own, on the same database with the same SSL rule and
 * search path, for a side channel that must never wait behind the shared
 * pool's queue: the dropship process heartbeat (step 1 PR A, verify V5), whose
 * row other releases read to tell whether this process is alive. Every
 * statement and query is bounded, and TCP keepalive finds a dead connection.
 * The caller owns the pool and must listen for its "error" event.
 */
export function createSideChannelPool(config: {
  max: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
}): InstanceType<typeof Pool> {
  return new Pool({
    ...createDatabasePoolConfig({
      connectionString: connectionString || "postgresql://stub:stub@localhost:5432/stub",
      ssl: useSSL ? { rejectUnauthorized: false } : undefined,
      max: connectionString ? config.max : 0,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      keepAlive: true,
    }),
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.queryTimeoutMs,
  });
}

export const db = drizzle(pool, { schema });

export type ReleaseSchemaFallbackOutcome = "completed" | "failed_partway";

/**
 * Idempotent schema fallbacks (`... IF NOT EXISTS`) that predate the tracked
 * migrations in `migrations/`.
 *
 * Runs ONLY in the release phase (`scripts/release-schema-fallbacks.ts`, called
 * from `scripts/release.sh`). It must never run while the web process boots:
 * its ALTER TABLE statements need exclusive locks on live tables, the web
 * process used to wait for them before listening, and a single blocked lock
 * kept every dyno from starting (outages on 2026-11-10 and 2026-11-11).
 * `server/__tests__/unit/boot-does-not-change-schema.test.ts` enforces this.
 *
 * Do not add statements here. New schema goes in a tracked migration.
 */
export async function runReleaseSchemaFallbacks(): Promise<ReleaseSchemaFallbackOutcome> {
  let outcome: ReleaseSchemaFallbackOutcome = "completed";
  // A dedicated connection: the limits below are set for its whole session.
  const migrationsPool = new Pool(createDatabasePoolConfig({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
  }));
  const connection = await migrationsPool.connect();
  try {
    // The previous release is still serving traffic while this runs, so a
    // statement must not queue for long in front of live queries: bound every
    // statement and the routine as a whole (see startup-migration-guard.ts).
    // A limit that trips lands in the catch below, which skips the remainder.
    const client = await boundStartupMigrationClient(connection);
    // Both pools receive the same search_path in the PostgreSQL startup packet.
    // Unqualified names therefore resolve consistently before any query can run.

    // Retired (P4.1): the refund return lifecycle block and its inner try/catch.
    // wms.returns.status / source_event_key, the nullable shipment_id and its
    // wms_returns_shipment_id_fkey, wms.return_items and the four indexes are in
    // tracked migration 131_refund_line_disposition_authority.sql.

    // Retired (P4.1): the fulfillment-state ledger block. wms.line_fulfillments,
    // its indexes and wms.order_items.on_hold/hold_reason are created by tracked
    // migration 103_line_fulfillments_ledger.sql.

    // Retired (P4.1): the OMS/WMS reconciliation exceptions block and its inner
    // try/catch. wms.reconciliation_exceptions and its four indexes are in tracked
    // migration 109_oms_wms_reconciliation_exceptions.sql; the seven-value
    // classification check is in 0603_shipping_provider_label_direction.sql.

    // Retired (P4.1): the three order-combining blocks. The combined_order_groups
    // table and its columns, and orders.combined_group_id / combined_role, are in
    // tracked migration 001_order_combining.sql (same statements) and in the
    // baseline 0002_concerned_darwin.sql.

    // Retired (P4.1): the channel allocation tables block.
    // channels.channel_product_allocation, its unique (channel_id, product_id)
    // index and channels.channel_sync_log are in tracked migration
    // 024_channel_allocation_tables.sql and the baseline 0002_concerned_darwin.sql.

    // Retired (P4.1): the product lines block.
    // - inventory.cycle_counts.aisle_filter: baseline 0002_concerned_darwin.sql.
    // - inventory_transactions.reserved_qty_delta and its reservation index:
    //   116_reservation_ledger_qty.sql.
    // - catalog.product_lines, catalog.product_line_products,
    //   channels.channel_product_lines, their indexes and the default product
    //   line seed row: 037_product_lines.sql. The seed is no longer re-applied on
    //   every release, so a product line an operator removes stays removed.

    // Add location_codes column to cycle_counts for quick single-bin counts
    await client.query(`ALTER TABLE inventory.cycle_counts ADD COLUMN IF NOT EXISTS location_codes TEXT`);

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
    // Phase 1: ledger immutability (C5) — soft-delete column for inventory_transactions.
    await client.query(`ALTER TABLE inventory.inventory_transactions ADD COLUMN IF NOT EXISTS voided_at timestamptz DEFAULT NULL`);
    // Phase 1: forward-only on-hand guard (C2). NOT VALID so existing negative
    // drift is preserved for the reconciler to correct via ledgered adjustments.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_variant_qty_non_negative'
        ) THEN
          ALTER TABLE inventory.inventory_levels
            ADD CONSTRAINT chk_variant_qty_non_negative CHECK (variant_qty >= 0) NOT VALID;
        END IF;
      END $$;
    `);
    // Reserve dedup is scoped to a supply segment so a recipe-managed order
    // item can reserve finished stock now and built shortfall later.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_reserve_dedup
        ON inventory.inventory_transactions
          (order_id, order_item_id, (COALESCE(reference_type, 'order')), (COALESCE(reference_id, order_id::text)))
        WHERE transaction_type = 'reserve'
          AND order_id IS NOT NULL
          AND order_item_id IS NOT NULL
          AND voided_at IS NULL
    `);
    // Phase 3: freeze-aware index for reservation bin lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_warehouse_locations_unfrozen
        ON warehouse.warehouse_locations (id)
        WHERE cycle_count_freeze_id IS NULL
    `);
    // Retired (P4.1): the shipment dedup index and its inner try/catch.
    // uq_outbound_shipments_external_fulfillment_id is in tracked migration
    // 0579_outbound_shipment_fulfillment_dedup.sql, which raises on duplicates
    // instead of logging and carrying on.
    // Phase 4: receipt dedup — one receipt ledger row per (receiving_order, variant, location)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_line_dedup
        ON inventory.inventory_transactions (receiving_line_id)
        WHERE transaction_type = 'receipt'
          AND receiving_line_id IS NOT NULL
          AND voided_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_legacy_dedup
        ON inventory.inventory_transactions (receiving_order_id, product_variant_id, to_location_id)
        WHERE transaction_type = 'receipt'
          AND receiving_line_id IS NULL
          AND receiving_order_id IS NOT NULL
          AND product_variant_id IS NOT NULL
          AND to_location_id IS NOT NULL
          AND voided_at IS NULL
    `);
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
      CREATE TABLE IF NOT EXISTS catalog.product_types (
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
      CREATE TABLE IF NOT EXISTS ebay.ebay_listing_rules (
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
      CREATE TABLE IF NOT EXISTS ebay.ebay_category_mappings (
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
      CREATE TABLE IF NOT EXISTS oms.oms_orders (
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_status ON oms.oms_orders(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_channel ON oms.oms_orders(channel_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_ordered ON oms.oms_orders(ordered_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_orders_external ON oms.oms_orders(external_order_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oms.oms_order_lines (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
        product_variant_id INTEGER REFERENCES catalog.product_variants(id),
        external_line_item_id VARCHAR(100),
        sku VARCHAR(100),
        title VARCHAR(300),
        variant_title VARCHAR(200),
        quantity INTEGER NOT NULL,
        channel_observed_quantity INTEGER NOT NULL DEFAULT 0,
        paid_quantity INTEGER NOT NULL DEFAULT 0,
        authority_fulfillable_quantity INTEGER NOT NULL DEFAULT 0,
        cancelled_quantity INTEGER NOT NULL DEFAULT 0,
        refunded_quantity INTEGER NOT NULL DEFAULT 0,
        wms_materialized_quantity INTEGER NOT NULL DEFAULT 0,
        authorization_status VARCHAR(30) NOT NULL DEFAULT 'authorized',
        authorized_at TIMESTAMP,
        authorized_by_event_id VARCHAR(100),
        authority_source_topic VARCHAR(50),
        authority_source_inbox_id INTEGER,
        unit_price_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        tax_cents INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_lines_order ON oms.oms_order_lines(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_lines_variant ON oms.oms_order_lines(product_variant_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oms.oms_order_line_authority_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_key VARCHAR(500) NOT NULL UNIQUE,
        event_type VARCHAR(50) NOT NULL,
        order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
        order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE CASCADE,
        source_topic VARCHAR(50) NOT NULL,
        source_event_id VARCHAR(100),
        source_inbox_id INTEGER,
        previous_channel_observed_quantity INTEGER,
        previous_paid_quantity INTEGER,
        previous_authority_fulfillable_quantity INTEGER,
        previous_authorization_status VARCHAR(30),
        channel_observed_quantity INTEGER NOT NULL,
        paid_quantity INTEGER NOT NULL,
        authority_fulfillable_quantity INTEGER NOT NULL,
        cancelled_quantity INTEGER NOT NULL DEFAULT 0,
        refunded_quantity INTEGER NOT NULL DEFAULT 0,
        authorization_status VARCHAR(30) NOT NULL,
        authorized_at TIMESTAMP,
        authorized_by_event_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_order ON oms.oms_order_line_authority_events(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_line ON oms.oms_order_line_authority_events(order_line_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_source ON oms.oms_order_line_authority_events(source_topic, source_event_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oms.oms_order_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        details JSONB,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_oms_events_order ON oms.oms_order_events(order_id)`);
    console.log("Checked OMS tables (oms_orders, oms_order_lines, oms_order_events)");

    // P0.2: the boot-time "zombie inventory_levels" DELETE was removed. It
    // hard-deleted financial rows with no inventory_transactions entry on
    // EVERY deploy (audit F2/P0.2) and could race a concurrent reserve
    // upsert. Empty level rows are harmless; if cleanup is ever needed it
    // belongs in a reviewed one-time script, ledgered, not in boot.

    // Migration: Sync Control System tables
    // 1. sync_settings — global sync engine config
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels.sync_settings (
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
      CREATE TABLE IF NOT EXISTS channels.sync_log (
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

    // Retired (P4.1): the shipping-engine column blocks. oms.oms_orders
    // shipstation_order_id/shipstation_order_key come from the table's own
    // CREATE in 0002/0071; shipping_engine/engine_order_ref from
    // 0574_oms_engine_agnostic_refs.sql; and the three wms.outbound_shipments
    // engine columns from 0573_engine_agnostic_shipment_refs.sql.

    // Retired (P4.1): the hold-flag block. wms.outbound_shipments.held and
    // held_at are created by the tracked migration *_outbound_shipment_hold_flags.sql.

    // P0.2: three boot-time hold/status rewrites were REMOVED here (audit F2,
    // CRITICAL). The worst — `SET held = false WHERE held = true` — silently
    // released every line-item hold on EVERY restart: its "held has no
    // writer" assumption went stale the day line-item holds (P2a,
    // wms/line-item-hold.ts) started writing held=true, and the pushShipment
    // held-refusal was the only thing keeping a held line from shipping.
    // The Phase 1a/1c one-time backfills (`held=true from status='on_hold'`,
    // on_hold rows restored to shipped/cancelled) ran long ago in prod; the
    // shipment status lifecycle belongs to the state machine, never to boot.

    // Retired (P4.1): the three eBay column blocks (6, 6b, 7).
    // ebay_category_mappings.listing_enabled, product_variants.ebay_listing_excluded
    // and products.ebay_browse_category_id/_name come from the tables' own CREATE
    // in 0002/0071. products.ebay_listing_excluded is added by
    // 051_ensure_catalog_columns.sql and made NOT NULL by the tracked migration
    // *_products_ebay_listing_excluded_not_null.sql.

    // 8. eBay Item Specifics (Aspects) management tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ebay.ebay_category_aspects (
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
      CREATE TABLE IF NOT EXISTS ebay.ebay_type_aspect_defaults (
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
      CREATE TABLE IF NOT EXISTS ebay.ebay_product_aspect_overrides (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES catalog.products(id),
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
    await client.query(CHANNEL_PRICING_RULES_DDL);
    console.log("Checked channel_pricing_rules table");

    // Retired (P4.1): the eBay policy override column block. The three
    // ebay_*_policy_override columns on products and product_variants are
    // created by 051_ensure_catalog_columns.sql and held at varchar(100) by the
    // tracked migration *_catalog_ebay_policy_override_capacity.sql.

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

    // Migration 049 REMOVED (Path A — no cross-schema DDL at startup):
    // shopify_orders is ORDER data (OMS domain) — not membership data. No app
    // should ALTER it on every boot. The source_name column already exists in
    // prod (it is also created by shellz-club's migration 0018 — that shellz-club
    // currently creates/writes order tables at all is architectural drift to
    // untangle in Path C; a membership app should not be the schema authority
    // for orders). Echelon only READS source_name for reconciliation. Any future
    // schema change to order tables belongs in a reviewed migration owned by the
    // order authority (Echelon), never in this boot routine.

    // ─── Migration 051: COGS Engine — FIFO cost tracking ──────────
    // Dropship V2 DDL is migration-owned; the Phase 0 startup DDL was removed.
    // Add COGS columns to inventory_lots
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_line_id INTEGER`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_unit_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS landed_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_unit_cost_cents NUMERIC(10,4) DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_received INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS qty_consumed INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS cost_source VARCHAR(20) DEFAULT 'manual'`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100)`);

    // P0.2: the cents→COGS-columns backfill UPDATE was removed — a one-time
    // mirror of migration 051, long applied in prod. Boot must not mutate
    // lot cost data (financial history).

    // --- Mills cost layers: AUTHORITATIVE source of truth for cost ------------
    // Integer mills (1/100 cent, 4-decimal dollars) so per-unit × pack-size and
    // FIFO × qty never amplify cent-rounding. *_cents stay as derived display
    // mirrors. These columns are NEW, so ADD COLUMN IF NOT EXISTS actually
    // applies — unlike the NUMERIC(10,4) upgrade above, which silently no-op'd on
    // the pre-existing bigint po/landed/total columns (that drift is why total
    // still stores whole cents today).
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS po_unit_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS packaging_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS landed_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS total_unit_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE oms.order_item_costs ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE oms.order_item_costs ADD COLUMN IF NOT EXISTS total_cost_mills BIGINT NOT NULL DEFAULT 0`);

    // P0.2: two classes of boot-time lot-cost DML were REMOVED here:
    //  1. The cents→mills backfills for inventory_lots and
    //     oms.order_item_costs — one-time mirrors of the mills PR1
    //     migration, long applied in prod.
    //  2. The PR5 "drifted mills" repair — a RECURRING silent re-write of
    //     lot cost data on every deploy. Repairing drift at boot masks
    //     whichever writer creates it (audit F8g: convertSku/transfers/CSV
    //     import mutate levels without lots). Drift must be surfaced by the
    //     lot reconciler (`wms:reconcile-lots`) and fixed at the writer or
    //     via the reviewed remediation script — never silently at boot.
    console.log("Checked inventory_lots + oms.order_item_costs mills cost columns");

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
      CREATE TABLE IF NOT EXISTS inventory.cost_adjustment_log (
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cal_lot ON inventory.cost_adjustment_log(lot_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cal_created ON inventory.cost_adjustment_log(created_at DESC)`);

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

    // ─── Migration 052 REMOVED (Path A — no cross-schema DDL at startup) ───────
    // These ADD COLUMN / CREATE INDEX statements on membership.plans,
    // membership.member_subscriptions, and membership.members duplicated schema
    // that shellz-club-app already creates via its own reviewed migrations (the
    // subscription engine is shellz-club's domain). Echelon must NOT manage the
    // membership schema on boot — doing so is what caused the 2026-06 incident
    // (a DROP COLUMN re-running every boot dropped plans.tier_level). Echelon
    // accesses membership.* at runtime via grants only; all membership schema
    // changes belong to shellz-club's migrations. NEVER reintroduce
    // membership.* DDL in this startup routine.

    // The subscription engine tables (subscription_billing_log,
    // subscription_events, selling_plan_map) used to be created here. They are
    // membership-domain tables owned by shellz-club's migrations - exactly what
    // the warning above forbids - and creating them here was actively harmful:
    //
    //   - They were created UNQUALIFIED, so they targeted `public`, while
    //     Drizzle reads them from `membership`
    //     (shared/schema/membership.schema.ts declares all three on
    //     membershipSchema). Anything this created was a duplicate nothing read.
    //
    //   - subscription_billing_log declared
    //     `member_subscription_id INTEGER REFERENCES membership.member_subscriptions(id)`
    //     while that id is varchar, so Postgres refused the foreign key with
    //     "cannot be implemented". Being the FIRST of the three, it aborted the
    //     whole routine and every remaining schema fallback was SKIPPED on every
    //     boot - silent schema drift, plus a stack trace in the logs each start.
    //
    // membership.subscription_events and membership.selling_plan_map already
    // exist, created by shellz-club. subscription_billing_log is not queried by
    // Echelon at all; if it is ever needed it belongs in a shellz-club migration.

    // Retired (P4.1): the OMS Shopify webhook column block. oms.oms_orders
    // financial_status, cancelled_at and refunded_at come from the table's own
    // CREATE in 0002_concerned_darwin.sql / 0071_create_namespaces.sql.

    // ─── Migration 0580: Forward Demand Events ──────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS procurement.demand_events (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(255) NOT NULL,
        event_type      VARCHAR(50)  NOT NULL DEFAULT 'manual_forecast',
        start_date      DATE NOT NULL,
        end_date        DATE,
        status          VARCHAR(20) NOT NULL DEFAULT 'planned',
        notes           TEXT,
        created_by      INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS procurement.demand_event_lines (
        id                  SERIAL PRIMARY KEY,
        demand_event_id     INTEGER NOT NULL REFERENCES procurement.demand_events(id) ON DELETE CASCADE,
        product_id          INTEGER NOT NULL,
        product_variant_id  INTEGER,
        expected_pieces     INTEGER NOT NULL CHECK (expected_pieces > 0),
        confidence          VARCHAR(10) NOT NULL DEFAULT 'medium',
        notes               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_demand_events_status_date ON procurement.demand_events (status, start_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_demand_event_lines_product ON procurement.demand_event_lines (product_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_demand_event_lines_event ON procurement.demand_event_lines (demand_event_id)`);
    console.log("Checked forward demand events tables (demand_events, demand_event_lines)");

    // Retired (P4.1): the WMS order dedup block. wms.orders.fulfillment_partition_key,
    // its default, backfill and two check constraints, the drop of
    // uq_wms_orders_oms_fulfillment_active and the unique index
    // uq_wms_orders_oms_fulfillment_partition_active are all in tracked migration
    // 111_oms_wms_fulfillment_partitions.sql (same statements).

  } catch (error) {
    // Deliberately resilient: tracked migrations are the fail-fast gate and
    // this routine is only the safety net behind them. But the failure mode is
    // "some schema fallbacks were silently skipped"
    // (DB-ROLE-SEPARATION-RUNBOOK.md), so report it and make it scream.
    // P4.1 consolidates to a single migration authority and removes this.
    outcome = "failed_partway";
    console.error(
      "[startup-migration] FAILED PARTWAY — remaining schema fallbacks were SKIPPED. " +
        "If a recent deploy relies on a new column/table, run its tracked migration " +
        "manually and investigate before assuming schema is current:",
      error,
    );
  } finally {
    connection.release();
    await migrationsPool.end().catch(() => {}); // Close the separate pool
  }
  return outcome;
}
