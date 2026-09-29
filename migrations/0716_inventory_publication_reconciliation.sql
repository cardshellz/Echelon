-- Explicitly supersede obsolete local request ownership. UNKNOWN remote outcomes
-- stay unknown: no completion timestamp, success receipt, or quantity acknowledgement
-- is invented. Installing this migration performs no recovery or activation.
CREATE TABLE inventory.quantity_publication_reconciliations (
  id bigserial PRIMARY KEY,
  activation_run_id bigint NOT NULL REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT,
  gate_epoch bigint NOT NULL CHECK(gate_epoch > 0),
  idempotency_key varchar(200) NOT NULL UNIQUE CHECK(btrim(idempotency_key) <> ''),
  actor varchar(100) NOT NULL CHECK(btrim(actor) <> ''),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review_hash varchar(64) NOT NULL CHECK(review_hash ~ '^[a-f0-9]{64}$'),
  review_payload jsonb NOT NULL CHECK(jsonb_typeof(review_payload)='object'),
  result_hash varchar(64) NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'),
  result_payload jsonb NOT NULL CHECK(jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE inventory.quantity_publication_reconciliation_attempts (
  reconciliation_id bigint NOT NULL REFERENCES inventory.quantity_publication_reconciliations(id) ON DELETE RESTRICT,
  attempt_id bigint NOT NULL UNIQUE REFERENCES inventory.quantity_publication_attempts(id) ON DELETE RESTRICT,
  before_record jsonb NOT NULL CHECK(jsonb_typeof(before_record)='object'),
  PRIMARY KEY(reconciliation_id,attempt_id)
);

CREATE FUNCTION inventory.guard_publication_reconciliation_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Publication reconciliation evidence is append-only' USING ERRCODE='23514';
  END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  -- The application must first TRY the exclusive publication lock. Requiring
  -- ownership here cannot wait for, or falsely terminate, a live provider owner.
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=918419 AND objid=0 AND objsubid=2 AND mode='ExclusiveLock' AND granted)
    OR NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM inventory.availability_activation_runs run
      JOIN inventory.quantity_publication_gate gate ON gate.activation_run_id=run.id AND gate.singleton=true
      JOIN inventory.availability_activation_freezes frozen_window ON frozen_window.activation_run_id=run.id AND frozen_window.released_at IS NULL
      CROSS JOIN inventory.availability_runtime_authority authority
      WHERE run.id=NEW.activation_run_id AND run.mode='activation' AND run.state='publishing'
        AND run.provider_write_attempted=false AND authority.singleton_key=true AND authority.authority='legacy'
        AND gate.epoch=NEW.gate_epoch) THEN
    RAISE EXCEPTION 'Reconciliation requires exclusive prepared legacy publication ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_reconciliation_command_guard BEFORE INSERT OR UPDATE OR DELETE
  ON inventory.quantity_publication_reconciliations FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_reconciliation_command();
CREATE TRIGGER publication_reconciliation_command_truncate BEFORE TRUNCATE
  ON inventory.quantity_publication_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_reconciliation_command();

CREATE FUNCTION inventory.guard_publication_reconciliation_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Publication reconciliation snapshots are append-only' USING ERRCODE='23514';
  END IF;
  PERFORM inventory.assert_cutover_admission_fence_owner();
  IF NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_reconciliations command
      JOIN inventory.quantity_publication_attempts attempt ON attempt.id=NEW.attempt_id
      WHERE command.id=NEW.reconciliation_id AND command.owner_transaction_id=pg_current_xact_id()
        AND attempt.owner_kind='legacy' AND attempt.state IN ('running','uncertain') AND attempt.gate_epoch < command.gate_epoch
        AND to_jsonb(attempt)=NEW.before_record
        AND command.result_payload->'supersededAttemptIds' @> jsonb_build_array(attempt.id::text)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(command.review_payload->'attempts') reviewed
          WHERE reviewed->>'attemptId'=attempt.id::text)) THEN
    RAISE EXCEPTION 'Reconciliation requires the exact reviewed unresolved attempt snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_reconciliation_member_guard BEFORE INSERT OR UPDATE OR DELETE
  ON inventory.quantity_publication_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_reconciliation_member();
CREATE TRIGGER publication_reconciliation_member_truncate BEFORE TRUNCATE
  ON inventory.quantity_publication_reconciliation_attempts FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_reconciliation_member();

ALTER TABLE inventory.quantity_publication_attempts DROP CONSTRAINT quantity_publication_attempts_state;
ALTER TABLE inventory.quantity_publication_attempts ADD CONSTRAINT quantity_publication_attempts_state
  CHECK(state IN ('running','succeeded','uncertain','resolved','rejected','not_sent','superseded_unknown'));
-- The existing terminal/completed_at constraint intentionally remains unchanged.
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514';
  END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
    PERFORM inventory.assert_cutover_admission_fence_owner();
    IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
      OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_reconciliation_attempts member
        JOIN inventory.quantity_publication_reconciliations command ON command.id=member.reconciliation_id
        WHERE member.attempt_id=OLD.id AND member.before_record=to_jsonb(OLD)
          AND command.owner_transaction_id=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Superseding an attempt requires its immutable reconciliation receipt; outcome evidence must not change' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.owner_token,NEW.owner_kind,NEW.gate_epoch,NEW.scope_key,NEW.scope,NEW.outbox_id,NEW.planned_outbox_id,NEW.affected_scope_keys,NEW.affected_scopes,NEW.planned_outbox_ids,NEW.started_at)
       IS DISTINCT FROM
     (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at) OR
     OLD.state IN ('succeeded','resolved','rejected','not_sent','superseded_unknown') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected','not_sent') OR
     (NEW.state IN ('rejected','not_sent') AND OLD.state<>'running') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='rejected' AND (
    NOT EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND r.outcome='rejected') OR
    EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=OLD.id AND (r.request_id IS NULL OR r.outcome='uncertain' OR r.http_status IS NULL OR r.response_hash IS NULL))
  ) THEN RAISE EXCEPTION 'Terminal rejection requires complete request evidence' USING ERRCODE='23514'; END IF;
  IF NEW.state='not_sent' AND (OLD.owner_kind<>'listing_setup_zero' OR NEW.outcome_hash IS NULL OR NEW.error_code IS NULL
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=OLD.id)) THEN
    RAISE EXCEPTION 'Preflight no-request completion requires zero request records and listing setup ownership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION inventory.guard_publication_reconciled_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state='superseded_unknown' THEN
    RAISE EXCEPTION 'Reconciliation must retain an existing attempt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_reconciled_insert_guard BEFORE INSERT ON inventory.quantity_publication_attempts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_reconciled_insert();

CREATE FUNCTION inventory.check_publication_reconciliation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained_ids jsonb; reviewed_ids jsonb;
BEGIN
  SELECT jsonb_agg(member.attempt_id::text ORDER BY member.attempt_id) INTO retained_ids
    FROM inventory.quantity_publication_reconciliation_attempts member WHERE member.reconciliation_id=NEW.id;
  SELECT jsonb_agg(reviewed->>'attemptId' ORDER BY (reviewed->>'attemptId')::bigint) INTO reviewed_ids
    FROM jsonb_array_elements(NEW.review_payload->'attempts') reviewed;
  IF retained_ids IS NULL OR retained_ids IS DISTINCT FROM NEW.result_payload->'supersededAttemptIds'
      OR retained_ids IS DISTINCT FROM reviewed_ids
      OR EXISTS(SELECT 1 FROM inventory.quantity_publication_reconciliation_attempts member
        JOIN inventory.quantity_publication_attempts attempt ON attempt.id=member.attempt_id
        WHERE member.reconciliation_id=NEW.id AND (attempt.state<>'superseded_unknown'
          OR (to_jsonb(attempt)-'state') IS DISTINCT FROM (member.before_record-'state'))) THEN
    RAISE EXCEPTION 'Reconciliation receipt and every retained attempt must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER publication_reconciliation_complete AFTER INSERT ON inventory.quantity_publication_reconciliations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_reconciliation_complete();

COMMENT ON TABLE inventory.quantity_publication_reconciliations IS
  'Operator-approved supersession of prior-epoch local request authority. Historical remote outcomes remain unknown; current outbox writes and verified readbacks are still mandatory.';
