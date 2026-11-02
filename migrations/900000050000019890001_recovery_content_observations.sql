-- A matching read is evidence of a check, not a newly requested Sync job.
-- Historical cycles and the recurring obligation remain immutable.
CREATE INDEX ebay_automatic_publication_recoveries_watch_attempt_idx
  ON inventory.ebay_automatic_publication_recoveries(watch_id,attempt_id);

ALTER TABLE inventory.ebay_publication_reconciliation_cycles
  DROP CONSTRAINT ebay_publication_reconciliation_cycles_check,
  ADD COLUMN content_check_kind text,
  ADD COLUMN content_checked_at timestamptz,
  ADD COLUMN content_evidence_hash text,
  ADD COLUMN content_identity_hash text,
  ADD COLUMN content_proof jsonb,
  ADD CONSTRAINT ebay_reconciliation_content_evidence CHECK (
    (content_check_kind IS NULL AND content_checked_at IS NULL AND content_evidence_hash IS NULL
      AND content_identity_hash IS NULL AND content_proof IS NULL)
    OR
    (content_check_kind IS NOT NULL AND content_check_kind IN ('provider_match','stock_only')
      AND content_checked_at IS NOT NULL AND content_evidence_hash IS NOT NULL AND content_identity_hash IS NOT NULL
      AND content_evidence_hash ~ '^[a-f0-9]{64}$' AND content_identity_hash ~ '^[a-f0-9]{64}$'
      AND ((content_check_kind='provider_match' AND content_proof IS NULL)
        OR (content_check_kind='stock_only' AND content_proof IS NOT NULL
          AND CASE WHEN jsonb_typeof(content_proof)='array' THEN jsonb_array_length(content_proof) BETWEEN 1 AND 250 ELSE false END)))
  ),
  ADD CONSTRAINT ebay_reconciliation_content_outcome CHECK (
    (stock_state='blocked' AND content_check_kind IS NULL)
    OR
    (stock_state<>'blocked' AND ((content_job_id IS NOT NULL AND content_check_kind IS NULL)
      OR (content_job_id IS NULL AND content_check_kind IS NOT NULL)))
  );
