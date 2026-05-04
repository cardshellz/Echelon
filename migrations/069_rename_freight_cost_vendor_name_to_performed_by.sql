-- Rename vendor_name to performed_by_name on inbound_freight_costs.
-- vendor_id (counterparty) is now the primary vendor reference.
-- performed_by_name is the entity that actually performed the service (informational).
--
-- NOT idempotent by nature (ALTER RENAME), but wrapped in exception block
-- so re-running won't crash if the column was already renamed.

DO $$
BEGIN
  ALTER TABLE procurement.inbound_freight_costs
    RENAME COLUMN vendor_name TO performed_by_name;
EXCEPTION
  WHEN undefined_column THEN
    -- Column already renamed or never existed — safe to ignore
    NULL;
END $$;
