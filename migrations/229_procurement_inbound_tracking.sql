BEGIN;

CREATE TABLE IF NOT EXISTS procurement.inbound_tracking_references (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_shipment_id integer NOT NULL REFERENCES procurement.inbound_shipments(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('searates', 'shipstation')),
  reference_type text NOT NULL CHECK (reference_type IN ('container', 'bill_of_lading', 'booking', 'parcel')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 100),
  carrier_code text NOT NULL CHECK (length(carrier_code) <= 100),
  enabled boolean NOT NULL,
  include_vessel_position boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  claim_version integer NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  lease_until timestamptz,
  next_poll_at timestamptz,
  refresh_not_before timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error_code text,
  last_error_message text,
  review_required boolean NOT NULL DEFAULT false,
  current_observation_id bigint,
  UNIQUE (inbound_shipment_id, provider, reference_type, reference, carrier_code),
  CHECK ((provider = 'shipstation' AND reference_type = 'parcel' AND NOT include_vessel_position) OR (provider = 'searates' AND reference_type <> 'parcel'))
);
CREATE INDEX IF NOT EXISTS inbound_tracking_due_idx ON procurement.inbound_tracking_references(next_poll_at, id) WHERE enabled AND NOT review_required;

CREATE TABLE IF NOT EXISTS procurement.inbound_tracking_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_id integer NOT NULL REFERENCES procurement.inbound_tracking_references(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND snapshot->>'version' = '1'),
  UNIQUE (reference_id, fingerprint),
  UNIQUE (reference_id, id)
);
CREATE INDEX IF NOT EXISTS inbound_tracking_observation_history_idx ON procurement.inbound_tracking_observations(reference_id, id DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbound_tracking_current_observation_fk' AND conrelid = 'procurement.inbound_tracking_references'::regclass) THEN
    ALTER TABLE procurement.inbound_tracking_references ADD CONSTRAINT inbound_tracking_current_observation_fk
      FOREIGN KEY(id, current_observation_id) REFERENCES procurement.inbound_tracking_observations(reference_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS procurement.inbound_tracking_attempts (
  reference_id integer NOT NULL REFERENCES procurement.inbound_tracking_references(id) ON DELETE RESTRICT,
  claim_version integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'duplicate', 'stale_source', 'superseded_lease', 'retry', 'review')),
  observation_id bigint,
  error_code text,
  message text,
  PRIMARY KEY(reference_id, claim_version),
  FOREIGN KEY(reference_id, observation_id) REFERENCES procurement.inbound_tracking_observations(reference_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS procurement.inbound_tracking_commands (
  request_key uuid PRIMARY KEY,
  inbound_shipment_id integer NOT NULL REFERENCES procurement.inbound_shipments(id) ON DELETE RESTRICT,
  reference_id integer NOT NULL REFERENCES procurement.inbound_tracking_references(id) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL,
  operation text NOT NULL CHECK (operation IN ('save', 'refresh')),
  revision integer NOT NULL CHECK (revision > 0),
  before_config jsonb,
  after_config jsonb NOT NULL,
  response jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_tracking_config_revision_uq ON procurement.inbound_tracking_commands(reference_id, revision) WHERE operation = 'save';
CREATE INDEX IF NOT EXISTS inbound_tracking_command_history_idx ON procurement.inbound_tracking_commands(reference_id, recorded_at DESC);
CREATE OR REPLACE FUNCTION procurement.protect_inbound_tracking_identity()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id, NEW.inbound_shipment_id, NEW.provider, NEW.reference_type, NEW.reference, NEW.carrier_code)
     IS DISTINCT FROM ROW(OLD.id, OLD.inbound_shipment_id, OLD.provider, OLD.reference_type, OLD.reference, OLD.carrier_code) THEN
    RAISE EXCEPTION 'Inbound tracking identity is immutable; pause it and add a corrected reference';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inbound_tracking_identity_immutable ON procurement.inbound_tracking_references;
CREATE TRIGGER inbound_tracking_identity_immutable BEFORE UPDATE ON procurement.inbound_tracking_references FOR EACH ROW EXECUTE FUNCTION procurement.protect_inbound_tracking_identity();
CREATE OR REPLACE FUNCTION procurement.reject_inbound_tracking_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Inbound tracking evidence is immutable; record a new observation or configuration revision';
END $$;
DROP TRIGGER IF EXISTS inbound_tracking_observations_immutable ON procurement.inbound_tracking_observations;
CREATE TRIGGER inbound_tracking_observations_immutable BEFORE UPDATE OR DELETE ON procurement.inbound_tracking_observations FOR EACH ROW EXECUTE FUNCTION procurement.reject_inbound_tracking_history_change();
DROP TRIGGER IF EXISTS inbound_tracking_attempts_immutable ON procurement.inbound_tracking_attempts;
CREATE TRIGGER inbound_tracking_attempts_immutable BEFORE UPDATE OR DELETE ON procurement.inbound_tracking_attempts FOR EACH ROW EXECUTE FUNCTION procurement.reject_inbound_tracking_history_change();
DROP TRIGGER IF EXISTS inbound_tracking_commands_immutable ON procurement.inbound_tracking_commands;
CREATE TRIGGER inbound_tracking_commands_immutable BEFORE UPDATE OR DELETE ON procurement.inbound_tracking_commands FOR EACH ROW EXECUTE FUNCTION procurement.reject_inbound_tracking_history_change();
COMMIT;
