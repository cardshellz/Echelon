-- Migration 052: Purchasing Dashboard
-- Adds reorder exclusion system, auto-draft runs, and PO source tracking

-- 1. Add reorder_excluded to catalog.products
ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS reorder_excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Create reorder_exclusion_rules (public schema — standalone table)
CREATE TABLE IF NOT EXISTS reorder_exclusion_rules (
  id          SERIAL PRIMARY KEY,
  field       VARCHAR(50)  NOT NULL,  -- 'category' | 'brand' | 'product_type' | 'sku_prefix' | 'sku_exact' | 'tag'
  value       TEXT         NOT NULL,
  created_by  VARCHAR(255),
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS reorder_exclusion_rules_field_value_uq
  ON reorder_exclusion_rules (field, value);

-- 3. Create auto_draft_runs (public schema)
CREATE TABLE IF NOT EXISTS auto_draft_runs (
  id                  SERIAL PRIMARY KEY,
  run_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  triggered_by        VARCHAR(50) NOT NULL DEFAULT 'scheduler',  -- 'scheduler' | 'manual'
  triggered_by_user   VARCHAR(255),
  status              VARCHAR(20) NOT NULL DEFAULT 'running',    -- 'running' | 'success' | 'error'
  items_analyzed      INTEGER NOT NULL DEFAULT 0,
  pos_created         INTEGER NOT NULL DEFAULT 0,
  pos_updated         INTEGER NOT NULL DEFAULT 0,
  lines_added         INTEGER NOT NULL DEFAULT 0,
  skipped_no_vendor   INTEGER NOT NULL DEFAULT 0,
  skipped_on_order    INTEGER NOT NULL DEFAULT 0,
  skipped_excluded    INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  summary_json        JSONB,
  finished_at         TIMESTAMP
);

-- 4. Add source and auto_draft_date to purchase_orders (public schema)
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS auto_draft_date DATE;

-- 5. Add auto-draft settings to warehouse_settings (public schema)
ALTER TABLE warehouse_settings
  ADD COLUMN IF NOT EXISTS auto_draft_include_order_soon  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_draft_skip_on_open_po     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_draft_skip_no_vendor      BOOLEAN NOT NULL DEFAULT TRUE;
