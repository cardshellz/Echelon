-- Forward-only workflow; no historical counter changes or inventory movements.
CREATE TABLE wms.pick_corrections (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id integer NOT NULL UNIQUE REFERENCES wms.order_items(id),
  physical_shipment_id bigint NOT NULL REFERENCES wms.physical_shipments(id),
  declared_quantity integer NOT NULL CHECK (declared_quantity > 0),
  state text NOT NULL CHECK (state IN ('confirmation_required', 'picking_required', 'resolved')),
  answer text CHECK (answer IN ('yes', 'no')),
  assigned_picker_id text,
  review_reason text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state <> 'picking_required' OR answer IS NOT NULL)
);
CREATE INDEX pick_corrections_open ON wms.pick_corrections (state, id)
  WHERE state <> 'resolved';

CREATE TABLE wms.pick_correction_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  correction_id integer NOT NULL REFERENCES wms.pick_corrections(id),
  command_id text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX pick_correction_events_by_correction ON wms.pick_correction_events (correction_id, id);
CREATE FUNCTION wms.protect_pick_correction_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Pick correction evidence is append-only'; END; $$;
CREATE TRIGGER pick_correction_events_immutable BEFORE UPDATE OR DELETE ON wms.pick_correction_events
  FOR EACH ROW EXECUTE FUNCTION wms.protect_pick_correction_events();
