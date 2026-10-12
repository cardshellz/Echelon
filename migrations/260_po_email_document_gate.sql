-- Content verification only: this migration does not establish PO approval authority.
-- Stop old workers and reconcile in-flight SMTP attempts before applying this gate.
-- Preserve every legacy body, delivery state and failure/acceptance timestamp.
ALTER TABLE procurement.po_email_outbox
  ADD COLUMN document_contract_version INTEGER,
  ADD COLUMN document_hash VARCHAR(64),
  ADD COLUMN document_source_revision VARCHAR(64),
  ADD COLUMN document_purpose VARCHAR(32),
  ADD COLUMN document_hold_reason VARCHAR(100),
  ADD COLUMN document_held_at TIMESTAMPTZ;

ALTER TABLE procurement.po_email_outbox
  ADD CONSTRAINT po_email_outbox_document_hold_pair_chk CHECK (
    (document_hold_reason IS NULL) = (document_held_at IS NULL)
    AND (document_hold_reason IS NULL OR length(document_hold_reason) > 0)
  ),
  ADD CONSTRAINT po_email_outbox_document_metadata_chk CHECK (
    (document_contract_version IS NULL AND document_hash IS NULL
      AND document_source_revision IS NULL AND document_purpose IS NULL)
    OR
    (document_contract_version IS NOT NULL AND document_contract_version > 0
      AND document_hash IS NOT NULL AND document_hash ~ '^[a-f0-9]{64}$'
      AND document_source_revision IS NOT NULL AND document_source_revision ~ '^[a-f0-9]{64}$'
      AND document_purpose IS NOT NULL
      AND document_purpose IN ('draft_preview', 'current_copy', 'cancelled_record'))
  );

-- Permit same-state processing updates for holds and lease renewal. The document
-- guard below independently gates every new or renewed lease.
CREATE OR REPLACE FUNCTION procurement.po_email_outbox_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.to_email IS DISTINCT FROM OLD.to_email
     OR NEW.cc_email IS DISTINCT FROM OLD.cc_email
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.html_body IS DISTINCT FROM OLD.html_body
     OR NEW.text_body IS DISTINCT FROM OLD.text_body
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
     OR NEW.replay_of_id IS DISTINCT FROM OLD.replay_of_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PO email outbox request snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('sent', 'partially_sent', 'dead_letter')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'PO email outbox terminal states are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'processing'))
     OR (OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'queued', 'sent', 'partially_sent', 'dead_letter')) THEN
    RAISE EXCEPTION 'Invalid PO email outbox status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


-- A hold is additional immutable evidence, not a rewrite of delivery history.
UPDATE procurement.po_email_outbox
SET document_hold_reason = 'LEGACY_DOCUMENT_UNVERIFIED',
    document_held_at = transaction_timestamp()
WHERE status IN ('queued', 'processing', 'dead_letter');

CREATE OR REPLACE FUNCTION procurement.po_email_document_is_verified(
  contract_version INTEGER, document_hash VARCHAR, source_revision VARCHAR,
  purpose VARCHAR, html_body TEXT, hold_reason VARCHAR
) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    contract_version = 1
    AND document_hash ~ '^[a-f0-9]{64}$'
    AND source_revision ~ '^[a-f0-9]{64}$'
    AND purpose = 'current_copy'
    AND length(html_body) > 0
    AND document_hash = encode(sha256(convert_to(html_body, 'UTF8')), 'hex')
    AND hold_reason IS NULL,
    FALSE
  )
$$;

-- Normally empty: valid snapshots need not be re-hashed by the safety sweep
-- on every worker tick. A future change to the immutable verifier must rebuild
-- this predicate index as part of that contract migration.
CREATE INDEX po_email_outbox_unverified_document_idx
  ON procurement.po_email_outbox(id)
  WHERE status IN ('queued', 'processing', 'dead_letter')
    AND document_hold_reason IS NULL
    AND NOT procurement.po_email_document_is_verified(document_contract_version, document_hash,
      document_source_revision, document_purpose, html_body, document_hold_reason);

CREATE OR REPLACE FUNCTION procurement.po_email_outbox_document_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.document_contract_version IS DISTINCT FROM OLD.document_contract_version
       OR NEW.document_hash IS DISTINCT FROM OLD.document_hash
       OR NEW.document_source_revision IS DISTINCT FROM OLD.document_source_revision
       OR NEW.document_purpose IS DISTINCT FROM OLD.document_purpose THEN
      RAISE EXCEPTION 'PO email document metadata is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.document_hold_reason IS NOT NULL AND
       (NEW.document_hold_reason IS DISTINCT FROM OLD.document_hold_reason
        OR NEW.document_held_at IS DISTINCT FROM OLD.document_held_at) THEN
      RAISE EXCEPTION 'PO email document holds are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('sent', 'partially_sent') AND
       (NEW.document_hold_reason IS DISTINCT FROM OLD.document_hold_reason
        OR NEW.document_held_at IS DISTINCT FROM OLD.document_held_at) THEN
      RAISE EXCEPTION 'Completed PO email history cannot acquire a document hold' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Protect old writer/worker paths too, including lease reclamation of an
  -- unsupported processing row. Completion of an already in-flight acceptance
  -- is allowed: a content hold must not erase an actual transport outcome.
  IF TG_OP = 'INSERT' OR
     (NEW.status = 'processing' AND
      (OLD.status IS DISTINCT FROM 'processing'
       OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count)) THEN
    IF NOT procurement.po_email_document_is_verified(
      NEW.document_contract_version, NEW.document_hash, NEW.document_source_revision,
      NEW.document_purpose, NEW.html_body, NEW.document_hold_reason
    ) THEN
      RAISE EXCEPTION 'PO email requires a verified current supplier document' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER po_email_outbox_document_guard
BEFORE INSERT OR UPDATE ON procurement.po_email_outbox
FOR EACH ROW EXECUTE FUNCTION procurement.po_email_outbox_document_guard();

COMMENT ON COLUMN procurement.po_email_outbox.document_contract_version IS
  'Rendered-content contract only; does not prove purchase approval or supplier receipt.';
COMMENT ON COLUMN procurement.po_email_outbox.document_source_revision IS
  'Hash of the external document projection; not a historical approved revision number.';
COMMENT ON COLUMN procurement.po_email_outbox.document_hold_reason IS
  'Append-only delivery hold. Review source evidence and create a new verified intent; never mutate this snapshot.';
