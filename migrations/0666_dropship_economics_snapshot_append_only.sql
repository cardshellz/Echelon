-- Dropship order economics snapshots are the immutable financial record of what
-- a vendor was charged and why (pricing_snapshot v2 carries the .ops cost
-- provenance and its evidence hash). Application code never updated or deleted
-- these rows; this makes that guarantee schema-enforced, matching the listing
-- price revision guard in migration 0657.
--
-- Note: intake rows are never deleted by application code (no DELETE path
-- exists), so the ON DELETE CASCADE from dropship_order_intake is unreachable in
-- practice; this trigger makes an accidental cascade fail loudly instead of
-- erasing financial history.

CREATE OR REPLACE FUNCTION dropship.guard_order_economics_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dropship order economics snapshots are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS dropship_order_economics_snapshot_immutable
  ON dropship.dropship_order_economics_snapshots;
CREATE TRIGGER dropship_order_economics_snapshot_immutable
  BEFORE UPDATE OR DELETE ON dropship.dropship_order_economics_snapshots
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_order_economics_snapshot_immutable();
