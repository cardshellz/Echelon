-- Create btree_gist extension to enable GIST indices with standard equality (=)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prevent overlapping active subscription intervals for a single member
ALTER TABLE "membership"."subscription_contracts"
ADD CONSTRAINT "prevent_overlapping_active_contracts"
EXCLUDE USING gist (
  "member_id" WITH =,
  tsrange("current_cycle_start_date", "current_cycle_end_date", '[)') WITH &&
)
WHERE (
  "status" IN ('active', 'paused') 
  AND "current_cycle_start_date" IS NOT NULL 
  AND "current_cycle_end_date" IS NOT NULL
);