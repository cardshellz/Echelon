-- Configurable read-only recommendation candidate score thresholds.
-- These thresholds control candidate band classification only; auto-draft
-- eligibility remains governed by the existing high-confidence quality gate.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS recommendation_candidate_score_strong_threshold INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS recommendation_candidate_score_review_threshold INTEGER NOT NULL DEFAULT 60;

UPDATE inventory.warehouse_settings
SET
  recommendation_candidate_score_strong_threshold = COALESCE(recommendation_candidate_score_strong_threshold, 80),
  recommendation_candidate_score_review_threshold = COALESCE(recommendation_candidate_score_review_threshold, 60);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_candidate_strong_score_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_candidate_strong_score_chk
      CHECK (recommendation_candidate_score_strong_threshold BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_candidate_review_score_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_candidate_review_score_chk
      CHECK (recommendation_candidate_score_review_threshold BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_settings_candidate_score_order_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_candidate_score_order_chk
      CHECK (recommendation_candidate_score_review_threshold <= recommendation_candidate_score_strong_threshold);
  END IF;
END $$;
