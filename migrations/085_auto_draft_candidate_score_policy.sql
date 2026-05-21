-- Disabled-by-default candidate-score approval policy for auto-draft.
-- Default preserves existing behavior. Operators can later choose the stricter
-- policy to require both the high-confidence quality gate and a strong
-- candidate score band before draft PO mutation.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS auto_draft_approval_policy VARCHAR(50) NOT NULL DEFAULT 'high_confidence_only';

UPDATE inventory.warehouse_settings
SET auto_draft_approval_policy = 'high_confidence_only'
WHERE auto_draft_approval_policy IS NULL
   OR auto_draft_approval_policy NOT IN ('high_confidence_only', 'high_confidence_and_strong_candidate');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_auto_draft_approval_policy_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_auto_draft_approval_policy_chk
      CHECK (auto_draft_approval_policy IN ('high_confidence_only', 'high_confidence_and_strong_candidate'));
  END IF;
END $$;
