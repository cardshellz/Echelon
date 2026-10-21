-- One provider-neutral recovery owner, retaining the existing trigger names for compatibility.
-- No existing attempt is resolved, no data is backfilled, and no provider request is sent.
-- Empty decisions audit a workflow retry with no inventory attempt; the channel owner
-- validates its separate saved intent and queues that retry in the same transaction.

CREATE OR REPLACE FUNCTION inventory.guard_ebay_operator_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM inventory.assert_ebay_operator_resume_locks(NEW.scope_keys);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.review_payload->>'previewHash' IS DISTINCT FROM NEW.preview_hash
    OR NEW.result_payload->>'providerWriteAttempted' IS DISTINCT FROM 'false'
    OR NEW.result_payload->>'replayed' IS DISTINCT FROM 'false'
    OR jsonb_typeof(NEW.result_payload->'attemptIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.result_payload->'attemptIds') NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Publication recovery requires the exact reviewed decision' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(NEW.result_payload->'attemptIds')=0 THEN
    IF NEW.review_payload->>'canResume' IS DISTINCT FROM 'false'
      OR NEW.review_payload->>'blockReason' IS DISTINCT FROM 'no_pending_attempts'
      OR NEW.review_payload->'attempts' IS DISTINCT FROM '[]'::jsonb
      OR EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts pending
        WHERE pending.state IN ('running','uncertain') AND pending.affected_scope_keys && NEW.scope_keys) THEN
      RAISE EXCEPTION 'Empty recovery must preserve the exact no-pending-attempt review' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.review_payload->>'canResume' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Recovery requires an authorized complete review' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION inventory.guard_ebay_operator_resume_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command inventory.quantity_publication_operator_resumes%ROWTYPE;
  attempt inventory.quantity_publication_attempts%ROWTYPE; actual jsonb;
BEGIN
  SELECT * INTO command FROM inventory.quantity_publication_operator_resumes WHERE id=NEW.resume_id;
  SELECT * INTO attempt FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  PERFORM inventory.assert_ebay_operator_resume_locks(command.scope_keys);
  IF command.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR attempt.state NOT IN ('running','uncertain') OR attempt.owner_kind NOT IN ('legacy','outbox')
    OR COALESCE(attempt.scope->>'providerKey','') NOT IN ('ebay','shopify','walmart')
    OR cardinality(attempt.affected_scope_keys)<1
    OR NOT attempt.affected_scope_keys <@ command.scope_keys
    OR to_jsonb(attempt) IS DISTINCT FROM NEW.before_record
    OR NOT command.result_payload->'attemptIds' @> jsonb_build_array(NEW.attempt_id::text)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(command.review_payload->'attempts') reviewed
      WHERE reviewed->>'attemptId'=NEW.attempt_id::text) THEN
    RAISE EXCEPTION 'Publication recovery requires the exact unresolved attempt and every affected scope' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_record',to_jsonb(q),'result_record',to_jsonb(r)) ORDER BY q.ordinal),'[]'::jsonb)
    INTO actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS DISTINCT FROM NEW.request_evidence THEN
    RAISE EXCEPTION 'Publication recovery must preserve every recorded request and response' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION inventory.check_ebay_operator_resume_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained_ids jsonb; reviewed_ids jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(member.attempt_id::text ORDER BY member.attempt_id),'[]'::jsonb) INTO retained_ids
    FROM inventory.quantity_publication_operator_resume_attempts member WHERE member.resume_id=NEW.id;
  SELECT COALESCE(jsonb_agg(reviewed->>'attemptId' ORDER BY (reviewed->>'attemptId')::bigint),'[]'::jsonb) INTO reviewed_ids
    FROM jsonb_array_elements(NEW.review_payload->'attempts') reviewed;
  IF retained_ids IS NULL OR retained_ids IS DISTINCT FROM NEW.result_payload->'attemptIds' OR retained_ids IS DISTINCT FROM reviewed_ids
    OR EXISTS(SELECT 1 FROM inventory.quantity_publication_operator_resume_attempts member
      JOIN inventory.quantity_publication_attempts attempt ON attempt.id=member.attempt_id WHERE member.resume_id=NEW.id
        AND (attempt.state<>'superseded_unknown' OR (to_jsonb(attempt)-'state') IS DISTINCT FROM (member.before_record-'state'))) THEN
    RAISE EXCEPTION 'Publication recovery decision and every preserved attempt must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
