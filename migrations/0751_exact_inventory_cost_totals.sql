-- The release executor owns the transaction and its migration-record insert.

-- Preserve exact extended amounts independently of rounded per-unit mirrors.
-- Nulls retain historical v0/v1 behavior; there is deliberately no blind backfill.
ALTER TABLE inventory.inventory_lots
  ADD COLUMN IF NOT EXISTS cost_basis_qty integer,
  ADD COLUMN IF NOT EXISTS product_total_cost_mills bigint,
  ADD COLUMN IF NOT EXISTS packaging_total_cost_mills bigint,
  ADD COLUMN IF NOT EXISTS landed_total_cost_mills bigint;

ALTER TABLE oms.order_item_costs
  ADD COLUMN IF NOT EXISTS cost_quantity_allocation_id bigint,
  ADD COLUMN IF NOT EXISTS product_total_cost_mills bigint,
  ADD COLUMN IF NOT EXISTS packaging_total_cost_mills bigint,
  ADD COLUMN IF NOT EXISTS landed_total_cost_mills bigint;

CREATE TABLE IF NOT EXISTS inventory.lot_cost_quantity_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  allocation_key text NOT NULL UNIQUE CHECK (btrim(allocation_key) <> ''),
  direction integer NOT NULL CHECK (direction IN (-1,0,1)),
  quantity integer NOT NULL CHECK (quantity > 0),
  intervals jsonb NOT NULL CHECK (jsonb_typeof(intervals) = 'array'),
  reverses_allocation_id bigint REFERENCES inventory.lot_cost_quantity_allocations(id) ON DELETE RESTRICT,
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  CHECK ((direction = -1) = (reverses_allocation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lot_cost_quantity_allocations_lot_idx
  ON inventory.lot_cost_quantity_allocations(inventory_lot_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS lot_cost_quantity_allocation_identity_lot_idx
  ON inventory.lot_cost_quantity_allocations(id,inventory_lot_id);

CREATE TABLE IF NOT EXISTS inventory.lot_cost_quantity_bases (
  inventory_lot_id integer PRIMARY KEY REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory.lot_cost_contribution_allocations (
  contribution_id bigint PRIMARY KEY REFERENCES inventory.lot_cost_contributions(id) ON DELETE RESTRICT,
  allocation_id bigint NOT NULL REFERENCES inventory.lot_cost_quantity_allocations(id) ON DELETE RESTRICT,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='inventory.inventory_lots'::regclass AND conname='lot_exact_cost_totals_valid') THEN
    ALTER TABLE inventory.inventory_lots ADD CONSTRAINT lot_exact_cost_totals_valid CHECK (
      (cost_basis_qty IS NULL AND product_total_cost_mills IS NULL AND packaging_total_cost_mills IS NULL AND landed_total_cost_mills IS NULL)
      OR (cost_basis_qty IS NOT NULL AND cost_basis_qty > 0 AND cost_basis_qty = qty_received
        AND product_total_cost_mills IS NOT NULL AND product_total_cost_mills >= 0
        AND packaging_total_cost_mills IS NOT NULL AND packaging_total_cost_mills >= 0
        AND landed_total_cost_mills IS NOT NULL AND landed_total_cost_mills >= 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='oms.order_item_costs'::regclass AND conname='order_item_cost_quantity_allocation_fk') THEN
    ALTER TABLE oms.order_item_costs ADD CONSTRAINT order_item_cost_quantity_allocation_fk
      FOREIGN KEY (cost_quantity_allocation_id,inventory_lot_id) REFERENCES inventory.lot_cost_quantity_allocations(id,inventory_lot_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='inventory.lot_cost_quantity_allocations'::regclass AND conname='cost_quantity_reversal_same_lot_fk') THEN
    ALTER TABLE inventory.lot_cost_quantity_allocations ADD CONSTRAINT cost_quantity_reversal_same_lot_fk
      FOREIGN KEY (reverses_allocation_id,inventory_lot_id) REFERENCES inventory.lot_cost_quantity_allocations(id,inventory_lot_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='oms.order_item_costs'::regclass AND conname='order_item_exact_cost_totals_valid') THEN
    ALTER TABLE oms.order_item_costs ADD CONSTRAINT order_item_exact_cost_totals_valid CHECK (
      (product_total_cost_mills IS NULL AND packaging_total_cost_mills IS NULL AND landed_total_cost_mills IS NULL)
      OR (cost_quantity_allocation_id IS NOT NULL AND product_total_cost_mills IS NOT NULL
        AND packaging_total_cost_mills IS NOT NULL AND landed_total_cost_mills IS NOT NULL
        AND product_total_cost_mills::numeric + packaging_total_cost_mills::numeric + landed_total_cost_mills::numeric = total_cost_mills::numeric
        AND ((qty > 0 AND product_total_cost_mills >= 0 AND packaging_total_cost_mills >= 0 AND landed_total_cost_mills >= 0)
          OR (qty < 0 AND product_total_cost_mills <= 0 AND packaging_total_cost_mills <= 0 AND landed_total_cost_mills <= 0)))
    );
  END IF;
END;
$$;

-- Immutable financial custody of original quantity intervals is separate from
-- the physical inventory ledger. These records never move or reserve stock.
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'inventory.lot_cost_quantity_allocations', 'inventory.lot_cost_quantity_bases',
    'inventory.lot_cost_contribution_allocations'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=relation_name::regclass AND tgname='cost_quantity_immutable') THEN
      EXECUTE format('CREATE TRIGGER cost_quantity_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()', relation_name);
    END IF;
  END LOOP;
END;
$$;

