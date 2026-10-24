BEGIN;
CREATE TABLE procurement.shipment_history_corrections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_id integer NOT NULL REFERENCES procurement.inbound_shipments(id) ON DELETE RESTRICT,
  source_version text NOT NULL CHECK (source_version ~ '^[a-f0-9]{64}$'),
  actor_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  actor_name text NOT NULL CHECK (length(btrim(actor_name)) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  review jsonb NOT NULL CHECK (jsonb_typeof(review) = 'object' AND review ? 'before' AND review ? 'after' AND review ? 'protectedRecordsVersion'),
  UNIQUE(inbound_shipment_id, source_version)
);
CREATE FUNCTION procurement.protect_shipment_history_corrections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approved shipment history corrections are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shipment_history_correction_immutable BEFORE UPDATE OR DELETE ON procurement.shipment_history_corrections
  FOR EACH ROW EXECUTE FUNCTION procurement.protect_shipment_history_corrections();
CREATE TRIGGER shipment_history_correction_no_truncate BEFORE TRUNCATE ON procurement.shipment_history_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION procurement.protect_shipment_history_corrections();
COMMIT;
