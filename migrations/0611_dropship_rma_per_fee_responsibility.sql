ALTER TABLE dropship.dropship_return_fee_schedule
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

WITH unambiguous_defaults AS (
  SELECT fee_type, vendor_id, store_connection_id, MIN(id) AS fee_id
  FROM dropship.dropship_return_fee_schedule
  WHERE is_active = true AND effective_to IS NULL
  GROUP BY fee_type, vendor_id, store_connection_id
  HAVING COUNT(*) = 1
)
UPDATE dropship.dropship_return_fee_schedule fee
SET is_default = true, updated_at = NOW()
FROM unambiguous_defaults candidate
WHERE fee.id = candidate.fee_id AND fee.is_default = false;

CREATE UNIQUE INDEX IF NOT EXISTS dropship_return_fee_one_active_default_scope_idx
  ON dropship.dropship_return_fee_schedule (
    fee_type, COALESCE(vendor_id, 0), COALESCE(store_connection_id, 0)
  )
  WHERE is_active = true AND is_default = true AND effective_to IS NULL;

ALTER TABLE dropship.dropship_rma_inspections
  ADD COLUMN IF NOT EXISTS fee_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN dropship.dropship_return_fee_schedule.is_default IS
  'Marks the policy-selected default responsibility for this fee type and scope.';
COMMENT ON COLUMN dropship.dropship_rma_inspections.fee_breakdown IS
  'Immutable snapshot of configured and final per-fee responsibility, amount, policy evidence, and override reason.';
