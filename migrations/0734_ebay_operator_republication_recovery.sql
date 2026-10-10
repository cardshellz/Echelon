-- An explicit operator decision permits a fresh publication while preserving
-- unknown historical effects. No provider write, activation, or recovery occurs
-- during installation. This is not a fabricated terminal-response receipt.
CREATE TABLE inventory.quantity_publication_operator_resumes (
  id bigserial PRIMARY KEY,
  idempotency_key varchar(200) NOT NULL UNIQUE CHECK(length(btrim(idempotency_key))>0),
  actor varchar(100) NOT NULL CHECK(length(btrim(actor))>0),
  command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  scope_keys text[] NOT NULL CHECK(cardinality(scope_keys) BETWEEN 1 AND 251),
  review_payload jsonb NOT NULL CHECK(jsonb_typeof(review_payload)='object'),
  result_payload jsonb NOT NULL CHECK(jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE inventory.quantity_publication_operator_resume_attempts (
  resume_id bigint NOT NULL REFERENCES inventory.quantity_publication_operator_resumes(id),
  attempt_id bigint NOT NULL UNIQUE REFERENCES inventory.quantity_publication_attempts(id),
  before_record jsonb NOT NULL CHECK(jsonb_typeof(before_record)='object'),
  request_evidence jsonb NOT NULL CHECK(jsonb_typeof(request_evidence)='array'),
  PRIMARY KEY(resume_id,attempt_id)
);
CREATE FUNCTION inventory.assert_ebay_operator_resume_locks(keys text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owned_key text; lock_key bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND classid=918419 AND objid=0 AND objsubid=2 AND mode='ShareLock' AND granted) THEN
    RAISE EXCEPTION 'eBay recovery requires the shared publication gate' USING ERRCODE='23514';
  END IF;
  FOREACH owned_key IN ARRAY keys LOOP
    lock_key:=hashtextextended(owned_key,918420);
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=((lock_key>>32)&4294967295)::oid AND objid=(lock_key&4294967295)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN
      RAISE EXCEPTION 'eBay recovery requires every exact scope lock' USING ERRCODE='23514';
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION inventory.guard_ebay_operator_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM inventory.assert_ebay_operator_resume_locks(NEW.scope_keys);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.review_payload->>'previewHash' IS DISTINCT FROM NEW.preview_hash
    OR NEW.review_payload->>'canResume' IS DISTINCT FROM 'true'
    OR NEW.result_payload->>'providerWriteAttempted' IS DISTINCT FROM 'false'
    OR NEW.result_payload->>'replayed' IS DISTINCT FROM 'false'
    OR jsonb_typeof(NEW.result_payload->'attemptIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.result_payload->'attemptIds') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'eBay recovery requires the exact reviewed decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_operator_resume_insert BEFORE INSERT ON inventory.quantity_publication_operator_resumes
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_operator_resume();
CREATE FUNCTION inventory.guard_ebay_operator_resume_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command inventory.quantity_publication_operator_resumes%ROWTYPE;
  attempt inventory.quantity_publication_attempts%ROWTYPE; actual jsonb;
BEGIN
  SELECT * INTO command FROM inventory.quantity_publication_operator_resumes WHERE id=NEW.resume_id;
  SELECT * INTO attempt FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  PERFORM inventory.assert_ebay_operator_resume_locks(command.scope_keys);
  IF command.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR attempt.state NOT IN ('running','uncertain') OR attempt.owner_kind NOT IN ('legacy','outbox')
    OR attempt.scope->>'providerKey' IS DISTINCT FROM 'ebay'
    OR NOT attempt.affected_scope_keys <@ command.scope_keys
    OR to_jsonb(attempt) IS DISTINCT FROM NEW.before_record
    OR NOT command.result_payload->'attemptIds' @> jsonb_build_array(NEW.attempt_id::text)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(command.review_payload->'attempts') reviewed
      WHERE reviewed->>'attemptId'=NEW.attempt_id::text) THEN
    RAISE EXCEPTION 'eBay recovery requires the exact unresolved attempt and every affected scope' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_record',to_jsonb(q),'result_record',to_jsonb(r)) ORDER BY q.ordinal),'[]'::jsonb)
    INTO actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS DISTINCT FROM NEW.request_evidence THEN
    RAISE EXCEPTION 'eBay recovery must preserve every recorded request and response' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_operator_resume_attempt_insert BEFORE INSERT ON inventory.quantity_publication_operator_resume_attempts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_operator_resume_attempt();
CREATE TRIGGER ebay_operator_resumes_immutable BEFORE UPDATE OR DELETE ON inventory.quantity_publication_operator_resumes
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_operator_resume_attempts_immutable BEFORE UPDATE OR DELETE ON inventory.quantity_publication_operator_resume_attempts
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_operator_resumes_no_truncate BEFORE TRUNCATE ON inventory.quantity_publication_operator_resumes
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_operator_resume_attempts_no_truncate BEFORE TRUNCATE ON inventory.quantity_publication_operator_resume_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE FUNCTION inventory.check_ebay_operator_resume_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained_ids jsonb; reviewed_ids jsonb;
BEGIN
  SELECT jsonb_agg(member.attempt_id::text ORDER BY member.attempt_id) INTO retained_ids
    FROM inventory.quantity_publication_operator_resume_attempts member WHERE member.resume_id=NEW.id;
  SELECT jsonb_agg(reviewed->>'attemptId' ORDER BY (reviewed->>'attemptId')::bigint) INTO reviewed_ids
    FROM jsonb_array_elements(NEW.review_payload->'attempts') reviewed;
  IF retained_ids IS NULL OR retained_ids IS DISTINCT FROM NEW.result_payload->'attemptIds' OR retained_ids IS DISTINCT FROM reviewed_ids
    OR EXISTS(SELECT 1 FROM inventory.quantity_publication_operator_resume_attempts member
      JOIN inventory.quantity_publication_attempts attempt ON attempt.id=member.attempt_id WHERE member.resume_id=NEW.id
        AND (attempt.state<>'superseded_unknown' OR (to_jsonb(attempt)-'state') IS DISTINCT FROM (member.before_record-'state'))) THEN
    RAISE EXCEPTION 'eBay recovery decision and every preserved attempt must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ebay_operator_resume_complete AFTER INSERT ON inventory.quantity_publication_operator_resumes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_ebay_operator_resume_complete();
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514'; END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
    IF EXISTS(SELECT 1 FROM inventory.quantity_publication_operator_resume_attempts member
      JOIN inventory.quantity_publication_operator_resumes command ON command.id=member.resume_id
      WHERE member.attempt_id=OLD.id AND member.before_record=to_jsonb(OLD)
        AND command.owner_transaction_id=pg_current_xact_id()) THEN
      PERFORM inventory.assert_ebay_operator_resume_locks(OLD.affected_scope_keys);
      IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
        RAISE EXCEPTION 'Operator resume preserves the historical unknown outcome unchanged' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
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
    IS DISTINCT FROM (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at)
    OR OLD.state IN ('succeeded','resolved','rejected','not_sent','superseded_unknown') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected','not_sent')
    OR (NEW.state IN ('rejected','not_sent') AND OLD.state<>'running') THEN
    RAISE EXCEPTION 'Provider attempt identity and terminal evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution_basis='provider_response_terminal' AND (OLD.state NOT IN ('running','uncertain')
    OR (to_jsonb(NEW)-'state'-'completed_at'-'outcome_hash'-'resolution_basis')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'completed_at'-'outcome_hash'-'resolution_basis')
    OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_response_recoveries r WHERE r.attempt_id=OLD.id
      AND r.before_record=to_jsonb(OLD) AND r.evidence_hash=NEW.outcome_hash AND r.owner_transaction_id=pg_current_xact_id())) THEN
    RAISE EXCEPTION 'Automated response recovery requires its immutable atomic receipt' USING ERRCODE='23514';
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
