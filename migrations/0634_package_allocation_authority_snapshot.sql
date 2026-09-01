ALTER TABLE wms.package_allocation_plans
  ADD COLUMN authority_snapshot JSONB;

UPDATE wms.package_allocation_plans
SET authority_snapshot = jsonb_build_object(
  'contractVersion', 1,
  'authorityMode', 'shadow_only',
  'selectionAuthority', 'caller_supplied_unproven',
  'selectionCompleteness', 'unproven_caller_selection'
)
WHERE authority_snapshot IS NULL;

ALTER TABLE wms.package_allocation_plans
  ALTER COLUMN authority_snapshot SET NOT NULL;

ALTER TABLE wms.package_allocation_plans
  DROP CONSTRAINT package_allocation_plans_snapshots_chk;

ALTER TABLE wms.package_allocation_plans
  ADD CONSTRAINT package_allocation_plans_snapshots_chk
  CHECK (
    jsonb_typeof(authority_snapshot) = 'object'
    AND jsonb_typeof(state_snapshot) = 'object'
    AND jsonb_typeof(review_snapshot) = 'object'
  );
