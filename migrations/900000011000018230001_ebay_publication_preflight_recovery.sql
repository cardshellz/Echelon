-- A versioned eBay transport promises to commit every mutation request before
-- network I/O. Old attempts are deliberately NULL; installation proves nothing
-- about their callbacks and does not recover any historical work.
ALTER TABLE inventory.quantity_publication_attempts ADD COLUMN request_journal_contract jsonb;
ALTER TABLE inventory.quantity_publication_attempts ADD CONSTRAINT publication_request_journal_contract CHECK (
  request_journal_contract IS NULL OR (
    scope->>'providerKey'='ebay' AND jsonb_typeof(request_journal_contract)='object'
    AND request_journal_contract->>'version'='1' AND request_journal_contract->>'provider'='ebay'
    AND request_journal_contract->>'method' IN ('POST','PUT','DELETE')
    AND request_journal_contract->>'path' ~ '^/sell/inventory/v1/[^?#[:space:]]+$'
    AND length(request_journal_contract->>'path')<=1024
    AND request_journal_contract->>'requestHash' ~ '^[a-f0-9]{64}$'
    AND request_journal_contract ?& ARRAY['version','provider','method','path','requestHash']
  ) IS TRUE);

CREATE TABLE inventory.quantity_publication_no_request_recoveries (
  attempt_id bigint PRIMARY KEY REFERENCES inventory.quantity_publication_attempts(id),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object'),
  before_record jsonb NOT NULL CHECK(jsonb_typeof(before_record)='object'),
  created_at timestamptz NOT NULL,
  actor text NOT NULL DEFAULT 'system:quantity-provider-preflight-recovery'
    CHECK(actor='system:quantity-provider-preflight-recovery'),
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TRIGGER publication_no_request_recoveries_immutable BEFORE UPDATE OR DELETE
  ON inventory.quantity_publication_no_request_recoveries FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER publication_no_request_recoveries_no_truncate BEFORE TRUNCATE
  ON inventory.quantity_publication_no_request_recoveries FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();

CREATE FUNCTION inventory.guard_publication_no_request_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt inventory.quantity_publication_attempts%ROWTYPE; evidence jsonb; first_sku text; encoded_first_sku text; member_skus jsonb;
BEGIN
  SELECT * INTO attempt FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  PERFORM inventory.assert_ebay_operator_resume_locks(attempt.affected_scope_keys);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR attempt.state NOT IN ('running','uncertain') OR attempt.scope->>'providerKey' IS DISTINCT FROM 'ebay'
    OR to_jsonb(attempt) IS DISTINCT FROM NEW.before_record
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=NEW.attempt_id) THEN
    RAISE EXCEPTION 'No-request recovery requires exact inactive ownership and an empty durable mutation journal' USING ERRCODE='23514';
  END IF;
  IF NEW.proof->>'source'='request_journal_contract' THEN
    IF attempt.request_journal_contract IS NULL OR NEW.proof->'contract' IS DISTINCT FROM attempt.request_journal_contract THEN
      RAISE EXCEPTION 'No-request recovery must retain its admission-time journal contract' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.proof->>'source'='legacy_publish_preflight' THEN
    -- The channels owner supplies its validated immutable stage/event sequence.
    -- Inventory independently checks exact owned membership, first-member read,
    -- attempt timing and the absence of even a started mutation request.
    evidence:=NEW.proof->'evidence';
    SELECT jsonb_agg(item->>'externalInventoryItemId' ORDER BY (item->>'externalInventoryItemId') COLLATE "C"),
      min((item->>'externalInventoryItemId') COLLATE "C") INTO member_skus,first_sku
      FROM jsonb_array_elements(attempt.affected_scopes) item
      WHERE item->>'externalInventoryItemId' IS DISTINCT FROM attempt.scope->>'externalInventoryItemId';
    -- Match encodeURIComponent used by the protocol without treating encoded
    -- slashes, spaces or non-ASCII SKU bytes as a different first member.
    SELECT string_agg(CASE WHEN byte BETWEEN 48 AND 57 OR byte BETWEEN 65 AND 90 OR byte BETWEEN 97 AND 122
      OR byte IN (33,39,40,41,42,45,46,95,126) THEN chr(byte)
      ELSE '%'||upper(lpad(to_hex(byte),2,'0')) END,'' ORDER BY ordinal) INTO encoded_first_sku
      FROM (SELECT ordinal,get_byte(convert_to(first_sku,'UTF8'),ordinal) AS byte
        FROM generate_series(0,octet_length(first_sku)-1) ordinal) bytes;
    IF attempt.request_journal_contract IS NOT NULL OR attempt.owner_kind<>'legacy'
      OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
      OR attempt.scope->>'externalInventoryItemId' IS DISTINCT FROM 'group:'||(evidence->>'groupKey')
      OR member_skus IS NULL OR member_skus IS DISTINCT FROM evidence->'memberSkus'
      OR evidence#>>'{failedRequest,method}' IS DISTINCT FROM 'GET'
      OR evidence#>>'{failedRequest,httpStatus}' IS DISTINCT FROM '500'
      OR evidence#>'{failedRequest,errorCodes}' IS DISTINCT FROM '["25001"]'::jsonb
      OR evidence#>>'{failedRequest,path}' IS DISTINCT FROM '/sell/inventory/v1/offer?sku='||encoded_first_sku||'&marketplace_id='||(evidence->>'marketplaceId')
      OR (evidence->>'sourceEvidenceHash' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
      OR (evidence->>'jobId' ~ '^[a-f0-9-]{36}$') IS DISTINCT FROM true
      OR (evidence->>'revision' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true
      OR (evidence->>'stageEventId' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true
      OR (evidence->>'failureEventId' ~ '^[1-9][0-9]*$') IS DISTINCT FROM true
      OR evidence->>'stageStartedAt' IS NULL OR evidence->>'failureAt' IS NULL
      OR (evidence->>'stageEventId')::bigint >= (evidence->>'failureEventId')::bigint
      OR attempt.started_at < (evidence->>'stageStartedAt')::timestamptz
      OR attempt.started_at > (evidence->>'failureAt')::timestamptz
      OR NOT (evidence ?& ARRAY['jobId','revision','stageEventId','stageStartedAt','failureEventId','failureAt',
        'groupKey','marketplaceId','memberSkus','failedRequest','sourceEvidenceHash']) THEN
      RAISE EXCEPTION 'Historical no-request recovery needs the exact first-member publish preflight evidence' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported no-request recovery evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publication_no_request_recovery_guard BEFORE INSERT ON inventory.quantity_publication_no_request_recoveries
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_no_request_recovery();
CREATE FUNCTION inventory.check_publication_no_request_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.id=NEW.attempt_id
    AND a.state='not_sent' AND a.resolution_basis='owner_preflight_no_request' AND a.outcome_hash=NEW.evidence_hash) THEN
    RAISE EXCEPTION 'No-request recovery receipt and transition must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER publication_no_request_recovery_complete AFTER INSERT ON inventory.quantity_publication_no_request_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.check_publication_no_request_recovery_complete();

-- Preserve prior cutover, rejection and automatic-recovery protections.
CREATE OR REPLACE FUNCTION inventory.guard_quantity_publication_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Provider attempts are retained permanently' USING ERRCODE='23514'; END IF;
  IF NEW.state='superseded_unknown' AND OLD.state IN ('running','uncertain') THEN
    IF EXISTS(SELECT 1 FROM inventory.ebay_automatic_publication_recoveries receipt
      WHERE receipt.attempt_id=OLD.id AND receipt.before_record=to_jsonb(OLD)
        AND receipt.owner_transaction_id=pg_current_xact_id()) THEN
      PERFORM inventory.assert_ebay_operator_resume_locks(OLD.affected_scope_keys);
      IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
        RAISE EXCEPTION 'Automatic recovery preserves the historical unknown outcome unchanged' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
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
  IF (NEW.owner_token,NEW.owner_kind,NEW.gate_epoch,NEW.scope_key,NEW.scope,NEW.outbox_id,NEW.planned_outbox_id,NEW.affected_scope_keys,NEW.affected_scopes,NEW.planned_outbox_ids,NEW.started_at,NEW.request_journal_contract)
    IS DISTINCT FROM (OLD.owner_token,OLD.owner_kind,OLD.gate_epoch,OLD.scope_key,OLD.scope,OLD.outbox_id,OLD.planned_outbox_id,OLD.affected_scope_keys,OLD.affected_scopes,OLD.planned_outbox_ids,OLD.started_at,OLD.request_journal_contract)
    OR OLD.state IN ('succeeded','resolved','rejected','not_sent','superseded_unknown') OR NEW.state NOT IN ('succeeded','uncertain','resolved','rejected','not_sent')
    OR (NEW.state='rejected' AND OLD.state<>'running') THEN
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
  IF NEW.state='not_sent' AND (
    (OLD.owner_kind NOT IN ('listing_setup_zero','outbox') AND OLD.request_journal_contract IS NULL
      AND NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_no_request_recoveries receipt
        WHERE receipt.attempt_id=OLD.id AND receipt.before_record=to_jsonb(OLD)
          AND receipt.evidence_hash=NEW.outcome_hash AND receipt.owner_transaction_id=pg_current_xact_id()))
    OR NEW.outcome_hash IS NULL OR NEW.error_code IS NULL OR NEW.completed_at IS NULL
    OR NEW.resolution_basis IS DISTINCT FROM 'owner_preflight_no_request'
    OR EXISTS(SELECT 1 FROM inventory.quantity_provider_requests WHERE attempt_id=OLD.id)) THEN
    RAISE EXCEPTION 'Preflight no-request completion requires a journal contract or exact recovery receipt and zero request records' USING ERRCODE='23514';
  END IF;
  IF NEW.state='not_sent' AND (OLD.state='uncertain' OR EXISTS(
    SELECT 1 FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=OLD.id)) THEN
    IF NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_no_request_recoveries receipt
      WHERE receipt.attempt_id=OLD.id AND receipt.before_record=to_jsonb(OLD)
        AND receipt.evidence_hash=NEW.outcome_hash AND receipt.owner_transaction_id=pg_current_xact_id())
      OR (to_jsonb(NEW)-'state'-'completed_at'-'outcome_hash'-'resolution_basis'-'error_code')
        IS DISTINCT FROM (to_jsonb(OLD)-'state'-'completed_at'-'outcome_hash'-'resolution_basis'-'error_code')
      OR NEW.error_code IS DISTINCT FROM COALESCE(OLD.error_code,'PROVIDER_PREFLIGHT_NOT_SENT') THEN
      RAISE EXCEPTION 'Recovered no-request transitions must commit with their exact immutable receipt' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
