-- Append-only evidence for the reviewed full-catalog authority switch.
-- This migration does not switch authority, promote definitions, import claims,
-- alter stock, enqueue publications, or call any external provider.
CREATE TABLE inventory.availability_cutover_commits (
  activation_run_id bigint PRIMARY KEY
    REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  authority_revision bigint NOT NULL CHECK (authority_revision > 0),
  review_hash varchar(64) NOT NULL CHECK (review_hash ~ '^[a-f0-9]{64}$'),
  selection_manifest_hash varchar(64) NOT NULL CHECK (selection_manifest_hash ~ '^[a-f0-9]{64}$'),
  reconstruction_hash varchar(64) NOT NULL CHECK (reconstruction_hash ~ '^[a-f0-9]{64}$'),
  selection_manifest jsonb NOT NULL CHECK (jsonb_typeof(selection_manifest) = 'object'),
  reconstruction_receipt jsonb NOT NULL CHECK (jsonb_typeof(reconstruction_receipt) = 'object'),
  publication_manifest jsonb NOT NULL CHECK (jsonb_typeof(publication_manifest) = 'array'),
  publication_manifest_hash varchar(64) NOT NULL CHECK (publication_manifest_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key varchar(120) NOT NULL UNIQUE CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 120),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_hash varchar(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  actor varchar(100) NOT NULL CHECK (char_length(btrim(actor)) BETWEEN 1 AND 100),
  reason varchar(1000) NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TRIGGER availability_cutover_commits_update_guard
BEFORE UPDATE OR DELETE ON inventory.availability_cutover_commits
FOR EACH ROW EXECUTE FUNCTION inventory.reject_append_only_mutation();

COMMENT ON TABLE inventory.availability_cutover_commits IS
  'First canonical switch evidence. A receipt is not proof of full provider publication verification.';

-- Reuse the owning append-only command/event journal for explicit completion.
ALTER TABLE inventory.availability_activation_commands
  DROP CONSTRAINT availability_activation_commands_type_chk;
ALTER TABLE inventory.availability_activation_commands
  ADD CONSTRAINT availability_activation_commands_type_chk CHECK (command_type IN ('prepare','abort','finish'));
CREATE UNIQUE INDEX availability_activation_commands_one_finish_uq
  ON inventory.availability_activation_commands(activation_run_id) WHERE command_type='finish';

CREATE FUNCTION inventory.guard_cutover_commit_receipt_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  -- Function is installed by the later admission migration; PostgreSQL resolves
  -- this PL/pgSQL body when the command runs, not while creating the empty table.
  PERFORM inventory.assert_cutover_admission_fence_owner();
  IF NOT EXISTS (SELECT 1 FROM inventory.availability_runtime_authority authority
    JOIN inventory.availability_activation_runs activation ON activation.id=authority.activation_run_id
    WHERE authority.singleton_key=true AND authority.authority='canonical'
      AND authority.activation_run_id=NEW.activation_run_id AND authority.revision=NEW.authority_revision
      AND activation.state='active') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CUTOVER_RECEIPT_AUTHORITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER availability_cutover_commits_insert_guard
BEFORE INSERT ON inventory.availability_cutover_commits
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_commit_receipt_insert();
