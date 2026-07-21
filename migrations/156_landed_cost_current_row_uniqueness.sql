-- Landed-cost allocations and snapshots are current-state projections.
-- There must be exactly one allocation per cost/line and one current finalized
-- snapshot per shipment line. Abort instead of deleting duplicate financial
-- evidence if historical data violates either invariant.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM procurement.inbound_freight_allocations
    GROUP BY shipment_cost_id, inbound_shipment_line_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce inbound freight allocation uniqueness: duplicate cost/line rows require manual reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM procurement.landed_cost_snapshots
    WHERE inbound_shipment_line_id IS NOT NULL
    GROUP BY inbound_shipment_line_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce landed cost snapshot uniqueness: duplicate shipment-line snapshots require manual reconciliation';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inbound_freight_allocations_cost_line_uidx
  ON procurement.inbound_freight_allocations (shipment_cost_id, inbound_shipment_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS landed_cost_snapshots_shipment_line_uidx
  ON procurement.landed_cost_snapshots (inbound_shipment_line_id)
  WHERE inbound_shipment_line_id IS NOT NULL;
