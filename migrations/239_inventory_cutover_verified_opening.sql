-- Review evidence only. Installing this table does not change stock, costs,
-- claims, order state, publication or runtime authority.
-- Filename must sort after 236_inventory_cutover_admission.sql: the release
-- runner orders names lexically rather than by numeric prefix.
CREATE TABLE inventory.availability_cutover_opening_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authority_revision bigint NOT NULL CHECK (authority_revision > 0),
  configuration_run_id bigint REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  source_evidence_hash varchar(64) NOT NULL CHECK (source_evidence_hash ~ '^[a-f0-9]{64}$'),
  verification_hash varchar(64) NOT NULL CHECK (verification_hash ~ '^[a-f0-9]{64}$'),
  historical_exception_hash varchar(64) NOT NULL CHECK (historical_exception_hash ~ '^[a-f0-9]{64}$'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_hash varchar(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  evidence_payload jsonb NOT NULL CHECK (jsonb_typeof(evidence_payload) = 'object'),
  verification_payload jsonb NOT NULL CHECK (jsonb_typeof(verification_payload) = 'object'),
  assessment_payload jsonb NOT NULL CHECK (jsonb_typeof(assessment_payload) = 'object'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  idempotency_key varchar(120) NOT NULL UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 120),
  actor varchar(100) NOT NULL CHECK (char_length(btrim(actor)) BETWEEN 1 AND 100),
  reason varchar(1000) NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  verified_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (verified_at <= occurred_at),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (authority_revision, source_evidence_hash)
);

CREATE FUNCTION inventory.guard_cutover_opening_snapshot_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_revision bigint; current_configuration_run_id bigint; freeze_count bigint;
BEGIN
  -- Recording a verification uses the same drained, exclusive admission as the
  -- eventual cutover. The evidence capture and this insert share that fence.
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT revision INTO current_revision FROM inventory.availability_runtime_authority
    WHERE singleton_key = true AND authority = 'legacy' AND activation_run_id IS NULL;
  IF NOT FOUND OR current_revision IS DISTINCT FROM NEW.authority_revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CUTOVER_OPENING_AUTHORITY_CHANGED';
  END IF;
  SELECT count(*), max(activation_run_id) INTO freeze_count, current_configuration_run_id
    FROM inventory.availability_activation_freezes WHERE released_at IS NULL;
  IF freeze_count > 1 OR current_configuration_run_id IS DISTINCT FROM NEW.configuration_run_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CUTOVER_OPENING_CONFIGURATION_CHANGED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_cutover_opening_insert_guard
BEFORE INSERT ON inventory.availability_cutover_opening_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_opening_snapshot_insert();
CREATE TRIGGER availability_cutover_opening_append_only_guard
BEFORE UPDATE OR DELETE ON inventory.availability_cutover_opening_snapshots
FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER availability_cutover_opening_truncate_guard
BEFORE TRUNCATE ON inventory.availability_cutover_opening_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

COMMENT ON TABLE inventory.availability_cutover_opening_snapshots IS
  'Immutable operator-verified opening facts and unresolved historical exceptions. Not an inventory correction, cost rewrite, claim adoption, or authority activation.';

-- The complete capture also hashes receipt state, its latest attempt, and legacy
-- build demand. These owners were absent from migration236's manifest. Pin
-- them for the same transaction lifetime as every other census writer so an
-- admitted READ COMMITTED capture cannot miss a newly pending receipt or attempt.
-- The existing owner uses SHARE NOWAIT, including for lease-first writers: a
-- contending worker is rejected for retry rather than creating a lock-order wait.
CREATE TRIGGER aa_cutover_writer_admission
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON oms.channel_fulfillment_receipts
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
CREATE TRIGGER aa_cutover_writer_admission
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON oms.channel_fulfillment_receipt_attempts
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
CREATE TRIGGER aa_cutover_writer_admission
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON wms.order_build_demands
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
