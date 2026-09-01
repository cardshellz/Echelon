-- A newly created SKU or warehouse can have zero complete observed days.
-- Preserve that fact explicitly so trust classification fails closed until the
-- required history exists; do not misstate a partial day as a full day.
--
-- This changes evidence validation only. It does not activate ATP authority or
-- mutate inventory, reservations, recipes, channel policy, or provider quantity.

ALTER TABLE inventory.demand_evidence_snapshots
  DROP CONSTRAINT demand_evidence_snapshots_quantity_chk,
  ADD CONSTRAINT demand_evidence_snapshots_quantity_chk CHECK (
    irreversible_consumption_units >= 0
    AND observed_days >= 0
    AND daily_demand_milli_units >= 0
  );
