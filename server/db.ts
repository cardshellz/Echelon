import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";
import { createDatabasePoolConfig } from "./database-pool-config";
import { boundStartupMigrationClient } from "./startup-migration-guard";
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

    // Retired (P4.1): the performance indexes block.
    // - inventory.cycle_counts.location_codes: baseline 0002_concerned_darwin.sql.
    // - location code unique per warehouse: 038_location_code_warehouse_unique.sql.
    // - order_items, inventory_levels, picking_logs and orders indexes:
    //   002_consolidate_inventory_model.sql; the inventory level identity unique
    //   index: 0671_inventory_quantity_level_identity.sql.
    // - inventory_transactions.voided_at and chk_variant_qty_non_negative:
    //   0575_inventory_ledger_immutability.sql.
    // - reserve dedup index: 209_recipe_mixed_supply_reservations.sql; the
    //   unfrozen-locations index: 0577_reservation_dedup_and_freeze_index.sql.
    // - receipt dedup indexes: 155_receipt_line_idempotency.sql.
    // - idx_picking_logs_sku, idx_inventory_transactions_product_variant_id,
    //   idx_inventory_transactions_order_id and idx_orders_source_table_id had no
    //   tracked migration; the legacy_performance_indexes migration now creates
    //   them. idx_inventory_levels_pv_wl duplicated the identity unique index and
    //   is no longer created anywhere.

    // Retired (P4.1): the product types, eBay listing rules and eBay category
    // mappings blocks.
    // - catalog.product_types, products.product_type, ebay.ebay_listing_rules and
    //   ebay.ebay_category_mappings: baseline 0002_concerned_darwin.sql.
    // - The 16 product type rows and the ebay_listing_rules scope_type check had
    //   no tracked migration; the product_types_seed_and_listing_rule_scope_check
    //   migration now declares both.

    // Retired (P4.1): the OMS tables block.
    // - oms.oms_orders, oms.oms_order_lines, oms.oms_order_events and their
    //   indexes: 045_oms_tables.sql and baseline 0002_concerned_darwin.sql.
    // - oms.oms_order_line_authority_events and its indexes:
    //   107_oms_order_line_authority_events.sql.

    // P0.2: the boot-time "zombie inventory_levels" DELETE was removed. It
    // hard-deleted financial rows with no inventory_transactions entry on
    // EVERY deploy (audit F2/P0.2) and could race a concurrent reserve
    // upsert. Empty level rows are harmless; if cleanup is ever needed it
    // belongs in a reviewed one-time script, ledgered, not in boot.

    // Retired (P4.1): the sync control block.
    // - channels.sync_settings, channels.sync_log and its three indexes, the
    //   channels sync_enabled / sync_mode / sweep_interval_minutes columns and
    //   warehouses.feed_enabled: baseline 0002_concerned_darwin.sql.
    // - The settings row: 0669_inventory_publication_global_control_singleton.sql
    //   seeds it (disabled) when the table is empty. The fallback's insert used
    //   an unqualified name, which the search path resolves to a stale
    //   public.sync_settings where one exists, so it never guarded the real row.
    // - channels_sync_mode_check had no tracked migration; the
    //   channels_sync_mode_check migration now declares it.

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

    // Retired (P4.1): the eBay aspects block and the channel pricing rules block.
    // - ebay.ebay_category_aspects had no tracked migration; the
    //   ebay_category_aspects_table migration now creates it.
    // - ebay.ebay_type_aspect_defaults, ebay.ebay_product_aspect_overrides and
    //   channels.channel_pricing_rules still have no tracked CREATE. The tracked
    //   migration *_listing_intent_propagation.sql refuses to run unless they
    //   already exist, and migrations run before this routine, so this block
    //   could never create them for a database that needed them. Declaring them
    //   belongs to the buildable-from-migrations baseline work (REFACTOR-PLAN).

    // Retired (P4.1): the eBay policy override column block. The three
    // ebay_*_policy_override columns on products and product_variants are
    // created by 051_ensure_catalog_columns.sql and held at varchar(100) by the
    // tracked migration *_catalog_ebay_policy_override_capacity.sql.

    // Retired (P4.1): the two channel_allocation_rules blocks. The nullable
    // channel_id, the COALESCE form of car_channel_product_variant_idx and
    // floor_type are all in baseline 0002_concerned_darwin.sql (floor_type also in
    // 048_floor_type_days_of_cover.sql). The block dropped and rebuilt that unique
    // index on every release; nothing does that any more.

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
