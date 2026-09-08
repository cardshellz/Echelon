BEGIN;

CREATE TABLE IF NOT EXISTS procurement.cost_reporting_destinations (
  id uuid PRIMARY KEY,
  source_system_id varchar(100) NOT NULL,
  endpoint text NOT NULL CHECK (endpoint LIKE 'https://%'),
  binding_hash varchar(64) NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS procurement.cost_report_deliveries (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES procurement.cost_reporting_destinations(id) ON DELETE RESTRICT,
  source_event_id bigint NOT NULL REFERENCES inventory.cost_reporting_events(id) ON DELETE RESTRICT,
  application_id bigint NOT NULL REFERENCES inventory.cost_applications(id) ON DELETE RESTRICT,
  purchase_order_id integer NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE RESTRICT,
  envelope jsonb,
  state varchar(20) NOT NULL CHECK (state IN ('queued','processing','retry_required','dead_letter','acknowledged')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  cycle_attempt_count integer NOT NULL DEFAULT 0 CHECK (cycle_attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  acknowledgement jsonb,
  recorded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(destination_id,source_event_id),
  CHECK ((state='processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state='acknowledged') = (acknowledgement IS NOT NULL)),
  CHECK (envelope IS NOT NULL OR state='dead_letter')
);
CREATE INDEX IF NOT EXISTS cost_report_delivery_due_idx ON procurement.cost_report_deliveries(destination_id,next_attempt_at,id) WHERE state IN ('queued','retry_required','processing');
CREATE INDEX IF NOT EXISTS cost_report_delivery_purchase_idx ON procurement.cost_report_deliveries(purchase_order_id,recorded_at DESC,id);
CREATE TABLE IF NOT EXISTS procurement.cost_report_delivery_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES procurement.cost_report_deliveries(id) ON DELETE RESTRICT,
  action varchar(30) NOT NULL,
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  before_state jsonb,
  after_state jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_report_delivery_audit_delivery_idx ON procurement.cost_report_delivery_audit(delivery_id,id);
CREATE TABLE IF NOT EXISTS procurement.cost_report_retry_intents (
  delivery_id uuid NOT NULL REFERENCES procurement.cost_report_deliveries(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(delivery_id,actor,idempotency_key)
);
CREATE OR REPLACE FUNCTION procurement.protect_cost_report_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Reporting delivery history cannot be removed' USING ERRCODE='55000'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.destination_id IS DISTINCT FROM OLD.destination_id
    OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR NEW.envelope IS DISTINCT FROM OLD.envelope
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR (OLD.acknowledgement IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Reporting identity, payload and acknowledged history are immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cost_report_delivery_protected ON procurement.cost_report_deliveries;
CREATE TRIGGER cost_report_delivery_protected BEFORE UPDATE OR DELETE ON procurement.cost_report_deliveries FOR EACH ROW EXECUTE FUNCTION procurement.protect_cost_report_delivery();
DROP TRIGGER IF EXISTS cost_report_delivery_no_truncate ON procurement.cost_report_deliveries;
CREATE TRIGGER cost_report_delivery_no_truncate BEFORE TRUNCATE ON procurement.cost_report_deliveries FOR EACH STATEMENT EXECUTE FUNCTION procurement.protect_cost_report_delivery();
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['procurement.cost_reporting_destinations','procurement.cost_report_delivery_audit','procurement.cost_report_retry_intents'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=relation_name::regclass AND tgname='cost_report_immutable') THEN
      EXECUTE format('CREATE TRIGGER cost_report_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()',relation_name);
      EXECUTE format('CREATE TRIGGER cost_report_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()',relation_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
