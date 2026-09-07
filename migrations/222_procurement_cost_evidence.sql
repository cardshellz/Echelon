-- Additive, immutable cost evidence. This migration does not reprice or infer
-- provenance for any historical inventory. Application code owns validation.
BEGIN;

ALTER TABLE procurement.receiving_lines
  ADD COLUMN IF NOT EXISTS cost_source_kind varchar(30),
  ADD COLUMN IF NOT EXISTS cost_source_evidence jsonb;

ALTER TABLE procurement.vendor_invoice_lines ADD COLUMN IF NOT EXISTS cost_component_evidence jsonb;

CREATE TABLE IF NOT EXISTS procurement.cost_source_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  inbound_shipment_line_id integer REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT,
  component varchar(20) NOT NULL CHECK (component IN ('product','packaging','landed')),
  revision integer NOT NULL CHECK (revision > 0),
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  source_evidence jsonb,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  CHECK ((component = 'landed') = (inbound_shipment_line_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cost_source_revisions_fingerprint_idx
  ON procurement.cost_source_revisions(purchase_order_line_id, COALESCE(inbound_shipment_line_id, 0), component, fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS cost_source_revisions_sequence_uidx
  ON procurement.cost_source_revisions(purchase_order_line_id, COALESCE(inbound_shipment_line_id, 0), component, revision);

CREATE TABLE IF NOT EXISTS inventory.lot_cost_origins (
  inventory_lot_id integer PRIMARY KEY REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  receiving_line_id integer NOT NULL REFERENCES procurement.receiving_lines(id) ON DELETE RESTRICT,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  inbound_shipment_line_id integer REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT,
  units_per_variant_snapshot integer NOT NULL CHECK (units_per_variant_snapshot > 0),
  received_variant_qty integer NOT NULL CHECK (received_variant_qty > 0),
  purchase_start_base_piece bigint NOT NULL CHECK (purchase_start_base_piece >= 0),
  shipment_start_base_piece bigint CHECK (shipment_start_base_piece >= 0),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  CHECK ((inbound_shipment_line_id IS NULL) = (shipment_start_base_piece IS NULL))
);
CREATE INDEX IF NOT EXISTS lot_cost_origins_purchase_line_idx ON inventory.lot_cost_origins(purchase_order_line_id);
CREATE INDEX IF NOT EXISTS lot_cost_origins_receiving_line_idx ON inventory.lot_cost_origins(receiving_line_id);
CREATE INDEX IF NOT EXISTS lot_cost_origins_shipment_line_idx ON inventory.lot_cost_origins(inbound_shipment_line_id);

CREATE TABLE IF NOT EXISTS inventory.lot_cost_contributions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  output_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  operation_kind varchar(20) NOT NULL CHECK (operation_kind IN ('transfer','conversion','assembly','build')),
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  source_qty integer NOT NULL CHECK (source_qty > 0),
  output_qty integer NOT NULL CHECK (output_qty > 0),
  output_start_qty integer NOT NULL DEFAULT 0 CHECK (output_start_qty >= 0 AND output_start_qty < output_qty),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  CHECK (source_lot_id <> output_lot_id),
  UNIQUE (operation_key, source_lot_id, output_lot_id)
);
CREATE INDEX IF NOT EXISTS lot_cost_contributions_output_idx ON inventory.lot_cost_contributions(output_lot_id);
CREATE INDEX IF NOT EXISTS lot_cost_contributions_source_idx ON inventory.lot_cost_contributions(source_lot_id);

-- A manual component correction cannot be erased by a later freight or AP
-- replay. Releasing a protection requires a separately audited future command.
CREATE TABLE IF NOT EXISTS inventory.cost_component_protections (
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  component varchar(20) NOT NULL CHECK (component IN ('product','packaging','landed')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(inventory_lot_id,component)
);

CREATE TABLE IF NOT EXISTS inventory.cost_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_key varchar(64) NOT NULL UNIQUE CHECK (application_key ~ '^[0-9a-f]{64}$'),
  source_revision_id bigint NOT NULL REFERENCES procurement.cost_source_revisions(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL CHECK (status IN ('applied','retry_required','review_required')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_applications_source_idx ON inventory.cost_applications(source_revision_id,id);
CREATE TABLE IF NOT EXISTS inventory.cost_application_lots (
  application_id bigint NOT NULL REFERENCES inventory.cost_applications(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  PRIMARY KEY(application_id,inventory_lot_id)
);
CREATE INDEX IF NOT EXISTS cost_application_lots_lot_idx ON inventory.cost_application_lots(inventory_lot_id,application_id);

CREATE TABLE IF NOT EXISTS inventory.cost_reporting_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id bigint NOT NULL UNIQUE REFERENCES inventory.cost_applications(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL CHECK (contract_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS procurement.receipt_cost_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id) ON DELETE RESTRICT,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  requested_by text NOT NULL CHECK (btrim(requested_by) <> ''),
  requested_at timestamptz NOT NULL,
  UNIQUE(receiving_order_id,purchase_order_line_id)
);
CREATE TABLE IF NOT EXISTS procurement.receipt_cost_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES procurement.receipt_cost_requests(id) ON DELETE RESTRICT,
  state varchar(20) NOT NULL CHECK (state IN ('applied','review_required','retry_required')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_cost_attempts_request_idx ON procurement.receipt_cost_attempts(request_id,id);

CREATE OR REPLACE FUNCTION inventory.reject_cost_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cost evidence is immutable; record a new revision or application'
    USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'procurement.cost_source_revisions','inventory.lot_cost_origins',
    'inventory.lot_cost_contributions','inventory.cost_applications',
    'inventory.cost_application_lots','inventory.cost_reporting_events','inventory.cost_component_protections',
    'procurement.receipt_cost_requests','procurement.receipt_cost_attempts'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = relation_name::regclass AND tgname = 'cost_evidence_immutable') THEN
      EXECUTE format('CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()', relation_name);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
