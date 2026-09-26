-- Private staff configuration. Saving configuration never launches customer access.
CREATE TABLE returns.customer_return_settings (
  channel_id INTEGER PRIMARY KEY REFERENCES channels.channels(id),
  version INTEGER NOT NULL CHECK (version > 0),
  enabled BOOLEAN NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouse.warehouses(id),
  policy_id INTEGER NOT NULL REFERENCES returns.return_policies(id),
  carrier_id VARCHAR(80) NOT NULL CHECK (carrier_id ~ '^se(-[a-z0-9]+)+$'),
  service_code VARCHAR(100) NOT NULL CHECK (service_code ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  destination_address JSONB NOT NULL CHECK (jsonb_typeof(destination_address) = 'object'),
  contact_name VARCHAR(200) NOT NULL CHECK (btrim(contact_name) <> ''),
  contact_phone VARCHAR(50),
  updated_by VARCHAR(255) NOT NULL CHECK (btrim(updated_by) <> ''),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE returns.customer_return_settings_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id),
  version INTEGER NOT NULL CHECK (version > 0),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  before_snapshot JSONB,
  after_snapshot JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (channel_id, version)
);
CREATE FUNCTION returns.guard_customer_return_settings_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Return configuration history is append-only'; END; $$;
CREATE TRIGGER customer_return_settings_history_immutable
BEFORE UPDATE OR DELETE ON returns.customer_return_settings_events
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_settings_history();

-- Persist exact submission intent before provider reads. A lost HTTP response can
-- be resumed by command ID without saving order data in browser storage.
CREATE TABLE returns.customer_return_submission_commands (
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id),
  idempotency_key UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_snapshot JSONB NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
  status VARCHAR(20) NOT NULL CHECK (status IN ('preparing','accepted','rejected')),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  lease_actor VARCHAR(255) CHECK (lease_actor IS NULL OR btrim(lease_actor) <> ''),
  lease_token UUID NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  authorization_id BIGINT REFERENCES returns.customer_return_authorizations(id),
  error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_id, idempotency_key),
  CHECK ((status = 'accepted') = (authorization_id IS NOT NULL))
);

CREATE TABLE returns.customer_return_label_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id BIGINT NOT NULL REFERENCES returns.customer_return_label_attempts(id),
  before_status VARCHAR(20),
  after_status VARCHAR(20) NOT NULL,
  error_code VARCHAR(100),
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER customer_return_label_events_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_label_events
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

CREATE TABLE returns.customer_return_submission_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  idempotency_key UUID NOT NULL,
  before_status VARCHAR(20),
  after_status VARCHAR(20) NOT NULL,
  actor VARCHAR(255) NOT NULL CHECK (btrim(actor) <> ''),
  error_code VARCHAR(100),
  occurred_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(channel_id,idempotency_key) REFERENCES returns.customer_return_submission_commands(channel_id,idempotency_key)
);
CREATE TRIGGER customer_return_submission_events_immutable BEFORE UPDATE OR DELETE ON returns.customer_return_submission_events
FOR EACH ROW EXECUTE FUNCTION returns.reject_customer_return_authorization_evidence_mutation();

CREATE FUNCTION returns.guard_customer_return_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Return submission intent cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (
    (NEW.channel_id,NEW.idempotency_key,NEW.request_hash,NEW.request_snapshot,NEW.actor,NEW.created_at)
      IS DISTINCT FROM (OLD.channel_id,OLD.idempotency_key,OLD.request_hash,OLD.request_snapshot,OLD.actor,OLD.created_at)
    OR (OLD.status IN ('accepted','rejected') AND NEW IS DISTINCT FROM OLD)
  ) THEN RAISE EXCEPTION 'Return submission intent and terminal outcome are immutable'; END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM returns.customer_return_authorization_commands c
    WHERE c.channel_id=NEW.channel_id AND c.idempotency_key=NEW.idempotency_key::text
      AND c.authorization_id=NEW.authorization_id AND c.semantic_hash=NEW.request_hash
  ) THEN RAISE EXCEPTION 'Accepted return submission must match its exact authorization'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON returns.customer_return_submission_commands
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_submission();

CREATE FUNCTION returns.audit_customer_return_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO returns.customer_return_submission_events(channel_id,idempotency_key,before_status,after_status,actor,error_code,occurred_at)
  VALUES(NEW.channel_id,NEW.idempotency_key,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,COALESCE(NEW.lease_actor,NEW.actor),NEW.error_code,NEW.updated_at);
  RETURN NULL;
END $$;
CREATE TRIGGER customer_return_submission_audit AFTER INSERT OR UPDATE ON returns.customer_return_submission_commands
FOR EACH ROW EXECUTE FUNCTION returns.audit_customer_return_submission();

CREATE FUNCTION returns.guard_customer_return_label_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Return label attempts cannot be deleted'; END IF;
  IF (NEW.parcel_id,NEW.attempt_number,NEW.idempotency_key,NEW.request_snapshot,NEW.actor,NEW.started_at)
      IS DISTINCT FROM (OLD.parcel_id,OLD.attempt_number,OLD.idempotency_key,OLD.request_snapshot,OLD.actor,OLD.started_at)
    OR (OLD.status IN ('succeeded','failed') AND NEW IS DISTINCT FROM OLD)
    OR (OLD.status='uncertain' AND NEW.status NOT IN ('uncertain','succeeded'))
  THEN RAISE EXCEPTION 'Return label intent and terminal outcome are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_return_label_attempt_guard BEFORE UPDATE OR DELETE ON returns.customer_return_label_attempts
FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_return_label_attempt();
