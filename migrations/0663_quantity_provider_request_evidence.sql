-- Additive evidence only. Never reclassify historical uncertain/running attempts.
CREATE TABLE inventory.quantity_provider_requests (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES inventory.quantity_publication_attempts(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  method text NOT NULL CHECK (method IN ('POST','PUT','DELETE')),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND path LIKE '/sell/inventory/v1/%'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  UNIQUE(attempt_id,ordinal)
);
CREATE TABLE inventory.quantity_provider_request_results (
  request_id bigint PRIMARY KEY REFERENCES inventory.quantity_provider_requests(id),
  outcome text NOT NULL CHECK (outcome IN ('completed','rejected','uncertain')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  provider_request_id text CHECK (length(provider_request_id) BETWEEN 1 AND 200),
  response_hash text CHECK (response_hash ~ '^[a-f0-9]{64}$'),
  error_codes text[] NOT NULL CHECK (cardinality(error_codes)<=25),
  retry_not_before timestamptz,
  cooldown_scope text CHECK (cooldown_scope IN ('item','account')),
  recorded_at timestamptz NOT NULL,
  CHECK (outcome<>'rejected' OR (http_status IS NOT NULL AND response_hash IS NOT NULL)),
  CHECK (retry_not_before IS NULL OR retry_not_before>=recorded_at),
  CHECK ((retry_not_before IS NULL)=(cooldown_scope IS NULL))
);
CREATE TRIGGER quantity_provider_requests_immutable BEFORE UPDATE OR DELETE ON inventory.quantity_provider_requests
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER quantity_provider_request_results_immutable BEFORE UPDATE OR DELETE ON inventory.quantity_provider_request_results
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE TABLE inventory.quantity_publication_cooldowns (
  provider_key text NOT NULL CHECK (provider_key IN ('ebay','shopify')),
  provider_scope_type text NOT NULL CHECK (provider_scope_type IN ('account','location')),
  external_scope_id text NOT NULL CHECK (length(external_scope_id) BETWEEN 1 AND 240),
  -- Empty item key means account-wide throttle, never an actual empty SKU.
  external_inventory_item_id text NOT NULL CHECK (length(external_inventory_item_id) BETWEEN 0 AND 240),
  retry_not_before timestamptz NOT NULL,
  request_id bigint NOT NULL REFERENCES inventory.quantity_provider_request_results(request_id),
  PRIMARY KEY(provider_key,provider_scope_type,external_scope_id,external_inventory_item_id)
);

-- Existing constraints were unnamed. Select by their actual constrained column,
-- not PostgreSQL's generated check-number (which can vary between installations).
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid='inventory.quantity_publication_attempts'::regclass AND contype='c'
      AND (pg_get_constraintdef(oid) LIKE '%state%' OR pg_get_constraintdef(oid) LIKE '%resolution_basis%')
  LOOP EXECUTE format('ALTER TABLE inventory.quantity_publication_attempts DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
ALTER TABLE inventory.quantity_publication_attempts
  ADD CONSTRAINT quantity_publication_attempts_state CHECK (state IN ('running','succeeded','uncertain','resolved','rejected')),
  ADD CONSTRAINT quantity_publication_attempts_terminal CHECK ((state IN ('succeeded','resolved','rejected'))=(completed_at IS NOT NULL)),
  ADD CONSTRAINT quantity_publication_attempts_basis CHECK (resolution_basis IN ('owner_completion','operator_attestation','provider_rejection')),
  ADD CONSTRAINT quantity_publication_attempts_rejection_basis CHECK ((state='rejected')=(resolution_basis IS NOT DISTINCT FROM 'provider_rejection'));
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR
     (NEW.owner_token,NEW.owner_kind,NEW.gate_epoch,NEW.scope_key,NEW.scope,NEW.outbox_id,NEW.planned_outbox_id,NEW.affected_scope_keys,NEW.affected_scopes,NEW.planned_outbox_ids,NEW.started_at)
       IS DISTINCT FROM
     (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at) OR
     OLD.state IN ('succeeded','resolved','rejected') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected') OR
     (NEW.state='rejected' AND OLD.state<>'running') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='rejected' AND (
    NOT EXISTS (SELECT 1 FROM inventory.quantity_provider_requests q JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND r.outcome='rejected') OR
    EXISTS (SELECT 1 FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND (r.request_id IS NULL OR r.outcome='uncertain' OR r.http_status IS NULL OR r.response_hash IS NULL))
  ) THEN RAISE EXCEPTION 'Terminal rejection requires complete request evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
