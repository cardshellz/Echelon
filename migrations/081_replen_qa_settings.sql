-- Admin-owned daily replenishment QA sampling controls.
-- The picker still has no replen confirmation authority; these settings only
-- control background/admin QA cycle count selection.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS replen_qa_daily_enabled INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS replen_qa_daily_sample_limit INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS replen_qa_cooldown_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS replen_qa_include_pick_bins INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS replen_qa_include_pallet_locations INTEGER NOT NULL DEFAULT 1;

UPDATE inventory.warehouse_settings
SET
  replen_qa_daily_enabled = COALESCE(replen_qa_daily_enabled, 1),
  replen_qa_daily_sample_limit = COALESCE(NULLIF(replen_qa_daily_sample_limit, 0), 2),
  replen_qa_cooldown_days = COALESCE(replen_qa_cooldown_days, 30),
  replen_qa_include_pick_bins = COALESCE(replen_qa_include_pick_bins, 1),
  replen_qa_include_pallet_locations = COALESCE(replen_qa_include_pallet_locations, 1),
  updated_at = NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_replen_qa_sample_limit_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_replen_qa_sample_limit_chk
      CHECK (replen_qa_daily_sample_limit BETWEEN 1 AND 50) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_replen_qa_cooldown_days_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_replen_qa_cooldown_days_chk
      CHECK (replen_qa_cooldown_days BETWEEN 0 AND 365) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_replen_qa_scope_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_replen_qa_scope_chk
      CHECK (
        replen_qa_daily_enabled <> 1
        OR replen_qa_include_pick_bins = 1
        OR replen_qa_include_pallet_locations = 1
      ) NOT VALID;
  END IF;
END $$;
