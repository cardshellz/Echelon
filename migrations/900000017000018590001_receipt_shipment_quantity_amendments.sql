-- Approved quantity meaning changes preserve physical movements and original cost origins.
BEGIN;
CREATE TABLE procurement.receipt_shipment_quantity_amendments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_line_id integer NOT NULL REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  source_version varchar(64) NOT NULL CHECK(source_version ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK(btrim(actor_id) <> ''),
  actor_name text NOT NULL CHECK(btrim(actor_name) <> ''),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
  approved_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  UNIQUE(inbound_shipment_line_id,source_version)
);
CREATE TABLE procurement.receipt_shipment_quantity_results (
  amendment_id bigint PRIMARY KEY REFERENCES procurement.receipt_shipment_quantity_amendments(id) ON DELETE RESTRICT,
  summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object')
);
CREATE TABLE inventory.lot_cost_origin_amendments (
  amendment_id bigint NOT NULL REFERENCES procurement.receipt_shipment_quantity_amendments(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL REFERENCES inventory.lot_cost_origins(inventory_lot_id) ON DELETE RESTRICT,
  units_per_variant_snapshot integer NOT NULL CHECK(units_per_variant_snapshot > 0),
  purchase_start_base_piece bigint NOT NULL CHECK(purchase_start_base_piece >= 0),
  shipment_start_base_piece bigint CHECK(shipment_start_base_piece >= 0),
  PRIMARY KEY(amendment_id,inventory_lot_id)
);
CREATE INDEX lot_cost_origin_amendments_current_idx ON inventory.lot_cost_origin_amendments(inventory_lot_id,amendment_id DESC);
CREATE INDEX receipt_shipment_quantity_amendments_po_idx ON procurement.receipt_shipment_quantity_amendments(purchase_order_line_id,id);
CREATE FUNCTION inventory.validate_cost_origin_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory.lot_cost_origins origin
    JOIN procurement.receipt_shipment_quantity_amendments amendment ON amendment.id=NEW.amendment_id
    JOIN procurement.inbound_shipment_lines line ON line.id=amendment.inbound_shipment_line_id
    WHERE origin.inventory_lot_id=NEW.inventory_lot_id
      AND origin.purchase_order_line_id=amendment.purchase_order_line_id
      AND line.purchase_order_line_id=amendment.purchase_order_line_id
      AND (origin.inbound_shipment_line_id IS NULL)=(NEW.shipment_start_base_piece IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cost origin amendment must retain its original purchase and shipment ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_origin_amendment_ownership BEFORE INSERT ON inventory.lot_cost_origin_amendments
  FOR EACH ROW EXECUTE FUNCTION inventory.validate_cost_origin_amendment();
CREATE FUNCTION procurement.require_quantity_correction_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM procurement.receipt_shipment_quantity_results WHERE amendment_id=NEW.id) THEN
    RAISE EXCEPTION 'Quantity correction requires its completed before and after audit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quantity_correction_complete AFTER INSERT ON procurement.receipt_shipment_quantity_amendments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION procurement.require_quantity_correction_result();
CREATE VIEW inventory.effective_lot_cost_origins AS
SELECT origin.inventory_lot_id,origin.receiving_line_id,origin.purchase_order_line_id,origin.inbound_shipment_line_id,
  COALESCE(amendment.units_per_variant_snapshot,origin.units_per_variant_snapshot) AS units_per_variant_snapshot,
  origin.received_variant_qty,
  COALESCE(amendment.purchase_start_base_piece,origin.purchase_start_base_piece) AS purchase_start_base_piece,
  COALESCE(amendment.shipment_start_base_piece,origin.shipment_start_base_piece) AS shipment_start_base_piece,
  origin.recorded_by,origin.recorded_at
FROM inventory.lot_cost_origins origin
LEFT JOIN LATERAL (
  SELECT * FROM inventory.lot_cost_origin_amendments change
  WHERE change.inventory_lot_id=origin.inventory_lot_id ORDER BY change.amendment_id DESC LIMIT 1
) amendment ON true;
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['procurement.receipt_shipment_quantity_amendments','procurement.receipt_shipment_quantity_results','inventory.lot_cost_origin_amendments']
  LOOP
    EXECUTE format('CREATE TRIGGER quantity_amendment_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()',relation_name);
    EXECUTE format('CREATE TRIGGER quantity_amendment_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()',relation_name);
  END LOOP;
END $$;
COMMIT;
