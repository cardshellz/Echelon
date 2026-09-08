-- External provider admission is independent of database inventory/configuration admission.
-- Never infer a terminal provider outcome from lease expiry or a fresh quantity readback.
CREATE TABLE inventory.quantity_publication_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  activation_run_id bigint REFERENCES inventory.availability_activation_runs(id),
  suppressed_at timestamptz,
  CHECK ((activation_run_id IS NULL) = (suppressed_at IS NULL))
);
INSERT INTO inventory.quantity_publication_gate(singleton) VALUES (true);

CREATE TABLE inventory.quantity_publication_attempts (
  id bigserial PRIMARY KEY,
  owner_token uuid NOT NULL UNIQUE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('legacy','outbox')),
  gate_epoch bigint NOT NULL CHECK (gate_epoch >= 0),
  scope_key text NOT NULL CHECK (length(scope_key) = 64),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  outbox_id bigint REFERENCES inventory.inventory_publication_outbox(id),
  planned_outbox_id bigint REFERENCES inventory.inventory_publication_outbox(id),
  affected_scope_keys text[] NOT NULL,
  affected_scopes jsonb NOT NULL CHECK (jsonb_typeof(affected_scopes)='array' AND jsonb_array_length(affected_scopes)=cardinality(affected_scope_keys)),
  planned_outbox_ids bigint[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('running','succeeded','uncertain','resolved')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome_hash text CHECK (outcome_hash IS NULL OR length(outcome_hash) = 64),
  error_code text,
  resolution_basis text CHECK (resolution_basis IN ('owner_completion','operator_attestation')),
  CHECK ((owner_kind = 'outbox') = (outbox_id IS NOT NULL)),
  CHECK ((state IN ('succeeded','resolved')) = (completed_at IS NOT NULL))
);
CREATE INDEX quantity_publication_attempts_unresolved ON inventory.quantity_publication_attempts(id)
  WHERE state IN ('running','uncertain');
CREATE INDEX quantity_publication_attempts_scope ON inventory.quantity_publication_attempts(scope_key,id DESC);

CREATE TABLE inventory.quantity_publication_catchup (
  id bigserial PRIMARY KEY,
  scope_key text NOT NULL UNIQUE CHECK (length(scope_key) = 64),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  completed_revision bigint NOT NULL DEFAULT 0 CHECK (completed_revision >= 0 AND completed_revision <= revision),
  attempt_boundary_id bigint NOT NULL DEFAULT 0 CHECK (attempt_boundary_id >= 0),
  last_activation_run_id bigint REFERENCES inventory.availability_activation_runs(id),
  reason text NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz NOT NULL
);
CREATE INDEX quantity_publication_catchup_due ON inventory.quantity_publication_catchup(next_attempt_at,id)
  WHERE completed_revision < revision;

CREATE TABLE inventory.quantity_publication_attempt_resolutions (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL UNIQUE REFERENCES inventory.quantity_publication_attempts(id),
  idempotency_key text NOT NULL UNIQUE,
  actor text NOT NULL CHECK (length(trim(actor)) > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('provider_terminal_request_record','owner_process_and_request_termination_record')),
  terminal_outcome text NOT NULL CHECK (terminal_outcome IN ('completed','not_sent')),
  evidence_reference text NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  evidence_hash text NOT NULL CHECK (length(evidence_hash) = 64),
  command_hash text NOT NULL CHECK (length(command_hash) = 64),
  created_at timestamptz NOT NULL
);
CREATE TRIGGER quantity_publication_attempt_resolutions_immutable
BEFORE UPDATE OR DELETE ON inventory.quantity_publication_attempt_resolutions
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     (NEW.owner_token, NEW.owner_kind, NEW.gate_epoch, NEW.scope_key, NEW.scope, NEW.outbox_id, NEW.planned_outbox_id, NEW.affected_scope_keys, NEW.affected_scopes, NEW.planned_outbox_ids, NEW.started_at)
       IS DISTINCT FROM
     (OLD.owner_token, OLD.owner_kind, OLD.gate_epoch, OLD.scope_key, OLD.scope, OLD.outbox_id, OLD.planned_outbox_id, OLD.affected_scope_keys, OLD.affected_scopes, OLD.planned_outbox_ids, OLD.started_at) OR
     OLD.state IN ('succeeded','resolved') OR
     NEW.state NOT IN ('succeeded','uncertain','resolved') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quantity_publication_attempt_transition
BEFORE UPDATE OR DELETE ON inventory.quantity_publication_attempts
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_publication_attempt_transition();
