-- Migration 043: Parallel Allocation Engine
--
-- Replaces serial priority-drawdown allocation with parallel percentage model.
-- Adds warehouse-scoped channel assignments and unified allocation rules.
-- Old tables (channel_reservations, channel_product_allocation) are preserved
-- for data reference but no longer read by the allocation engine.

-- ============================================================================
-- 1. Channel Warehouse Assignments
-- ============================================================================
-- Controls which warehouses fulfill inventory for which channels.
-- If no assignments exist for a channel, ALL fulfillment warehouses are used (default behavior).

CREATE TABLE IF NOT EXISTS channel_warehouse_assignments (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS cwa_channel_warehouse_idx
  ON channel_warehouse_assignments(channel_id, warehouse_id);

CREATE INDEX IF NOT EXISTS cwa_channel_idx
  ON channel_warehouse_assignments(channel_id) WHERE enabled = true;

-- ============================================================================
-- 2. Channel Allocation Rules
-- ============================================================================
-- Unified allocation rules replacing channel_reservations + channel_product_allocation.
-- Scoping: channel-only (default), channel+product (override), channel+product+variant (most specific).
-- Most-specific rule wins.

CREATE TABLE IF NOT EXISTS channel_allocation_rules (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  product_id          INTEGER REFERENCES products(id) ON DELETE CASCADE,
  product_variant_id  INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  mode                VARCHAR(10) NOT NULL DEFAULT 'mirror',  -- mirror, share, fixed
  share_pct           INTEGER,                                 -- 1-100, used when mode='share'
  fixed_qty           INTEGER,                                 -- base units, used when mode='fixed'
  floor_atp           INTEGER DEFAULT 0,                       -- push 0 if base ATP < this
  ceiling_qty         INTEGER,                                 -- never show more than this
  eligible            BOOLEAN NOT NULL DEFAULT true,            -- false = blocked from channel
  notes               TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Unique constraint ensures one rule per scope level
CREATE UNIQUE INDEX IF NOT EXISTS car_channel_product_variant_idx
  ON channel_allocation_rules(channel_id, product_id, product_variant_id);

-- Lookup indexes for allocation engine
CREATE INDEX IF NOT EXISTS car_channel_idx
  ON channel_allocation_rules(channel_id);
CREATE INDEX IF NOT EXISTS car_channel_product_idx
  ON channel_allocation_rules(channel_id, product_id) WHERE product_id IS NOT NULL;

-- ============================================================================
-- 3. Seed default rules from existing channel config
-- ============================================================================
-- Migrate existing allocation_pct / allocation_fixed_qty from channels table
-- into the new channel_allocation_rules as channel-level defaults.

INSERT INTO channel_allocation_rules (channel_id, product_id, product_variant_id, mode, share_pct, fixed_qty, eligible)
SELECT
  id AS channel_id,
  NULL AS product_id,
  NULL AS product_variant_id,
  CASE
    WHEN allocation_fixed_qty IS NOT NULL THEN 'fixed'
    WHEN allocation_pct IS NOT NULL THEN 'share'
    ELSE 'mirror'
  END AS mode,
  allocation_pct AS share_pct,
  allocation_fixed_qty AS fixed_qty,
  true AS eligible
FROM channels
WHERE status = 'active'
ON CONFLICT (channel_id, product_id, product_variant_id) DO NOTHING;

-- ============================================================================
-- 4. Update allocation_audit_log to support new methods
-- ============================================================================
-- No schema change needed — allocation_method varchar(30) already supports
-- new values (mirror, share, fixed, zero). The details jsonb will carry
-- warehouse scoping info.

COMMENT ON TABLE channel_warehouse_assignments IS 'Maps which warehouses fulfill for which sales channels. Empty = all fulfillment warehouses.';
COMMENT ON TABLE channel_allocation_rules IS 'Parallel allocation rules. Replaces serial drawdown. Scoped: channel → product → variant (most specific wins).';
