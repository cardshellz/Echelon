-- Policy selection now follows the canonical resolver for each new intake.
-- Retain the old reference as historical compatibility data; it no longer grants
-- authority, and new shipping-settings writes leave it empty. RMA policy
-- snapshots and every accepted operational case remain unchanged.
ALTER TABLE returns.customer_return_settings ALTER COLUMN policy_id DROP NOT NULL;
COMMENT ON COLUMN returns.customer_return_settings.policy_id IS
  'Deprecated historical selection. New return authorization resolves the active channel policy; shipping settings do not select it.';
