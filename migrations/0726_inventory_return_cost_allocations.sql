-- The release executor owns the transaction, including its migration record.

ALTER TABLE oms.order_item_costs ADD COLUMN IF NOT EXISTS cost_precision_version integer NOT NULL DEFAULT 0
  CHECK (cost_precision_version IN (0,1));
ALTER TABLE inventory.lot_cost_contributions DROP CONSTRAINT lot_cost_contributions_operation_kind_check;
ALTER TABLE inventory.lot_cost_contributions ADD CONSTRAINT lot_cost_contributions_operation_kind_check
  CHECK (operation_kind IN ('transfer','conversion','assembly','build','return'));

CREATE TABLE inventory.return_cost_allocations (
  returned_lot_id integer PRIMARY KEY REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  source_order_item_cost_id integer REFERENCES oms.order_item_costs(id) ON DELETE RESTRICT,
  wms_order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  wms_order_item_id integer REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  evidence_state varchar(20) NOT NULL CHECK (evidence_state IN ('confirmed','estimated','unknown','review_required')),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX return_cost_allocations_source ON inventory.return_cost_allocations(source_order_item_cost_id);
CREATE INDEX return_cost_allocations_operation ON inventory.return_cost_allocations(operation_key,returned_lot_id);
CREATE INDEX return_cost_allocations_item ON inventory.return_cost_allocations(wms_order_item_id);

CREATE TABLE inventory.return_commands (
  idempotency_key text PRIMARY KEY CHECK (btrim(idempotency_key) <> ''),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  wms_order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.return_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.return_commands
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();
