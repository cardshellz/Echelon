-- Migration 083: Add auto-draft mode to warehouse settings
-- draft_po preserves current behavior. review_only generates auditable
-- recommendation runs without mutating purchase orders.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS auto_draft_mode VARCHAR(20) NOT NULL DEFAULT 'draft_po';

UPDATE inventory.warehouse_settings
SET auto_draft_mode = 'draft_po'
WHERE auto_draft_mode IS NULL OR auto_draft_mode NOT IN ('draft_po', 'review_only');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_auto_draft_mode_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_auto_draft_mode_chk
      CHECK (auto_draft_mode IN ('draft_po', 'review_only'));
  END IF;
END $$;
