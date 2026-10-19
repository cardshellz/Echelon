-- Pending allocation: copy these exact bytes into the generated PR migration.
-- Picks from a lot with exact cost totals (0751) record the lot's exact
-- extended share, which can differ from the rounded unit mirror times quantity.
-- 0751 relaxed oms.order_item_costs for that but left this table on the uniform
-- rule, so those picks failed with availability_claim_pick_movements_cost_chk.
-- The rule now matches shared/utils/recorded-cost-total.ts: uniform rows still
-- need total = unit x quantity; an exact row must mirror its linked
-- quantity-allocated cost row exactly. Existing rows already satisfy both.

ALTER TABLE inventory.availability_claim_pick_movements
  DROP CONSTRAINT IF EXISTS availability_claim_pick_movements_cost_chk;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory.availability_claim_pick_movements'::regclass
      AND conname = 'availability_claim_pick_movements_cost_nonnegative_chk') THEN
    -- NOT VALID + VALIDATE: no long ACCESS EXCLUSIVE scan on a hot pick table.
    ALTER TABLE inventory.availability_claim_pick_movements
      ADD CONSTRAINT availability_claim_pick_movements_cost_nonnegative_chk
      CHECK (unit_cost_mills >= 0 AND total_cost_mills >= 0) NOT VALID;
  END IF;
END;
$$;
ALTER TABLE inventory.availability_claim_pick_movements
  VALIDATE CONSTRAINT availability_claim_pick_movements_cost_nonnegative_chk;

CREATE OR REPLACE FUNCTION inventory.enforce_pick_movement_cost_total()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.total_cost_mills::numeric = NEW.unit_cost_mills::numeric * NEW.quantity::numeric THEN
    RETURN NEW;
  END IF;
  -- Pick rows link a positive cost row; unpick rows link its negative reversal.
  IF EXISTS (
    SELECT 1 FROM oms.order_item_costs cost
    WHERE cost.id = NEW.order_item_cost_id
      AND cost.cost_quantity_allocation_id IS NOT NULL
      AND abs(cost.qty::numeric) = NEW.quantity::numeric
      AND abs(cost.total_cost_mills::numeric) = NEW.total_cost_mills::numeric
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'availability_claim_pick_movements_cost_chk',
    MESSAGE = 'Pick movement cost must equal unit cost times quantity, or exactly mirror its quantity-allocated order item cost.';
END;
$$;

DROP TRIGGER IF EXISTS availability_claim_pick_movements_cost_total
  ON inventory.availability_claim_pick_movements;
CREATE TRIGGER availability_claim_pick_movements_cost_total
  BEFORE INSERT OR UPDATE OF quantity, unit_cost_mills, total_cost_mills, order_item_cost_id
  ON inventory.availability_claim_pick_movements
  FOR EACH ROW EXECUTE FUNCTION inventory.enforce_pick_movement_cost_total();
