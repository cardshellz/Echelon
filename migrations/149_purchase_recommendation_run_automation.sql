ALTER TABLE procurement.purchase_recommendation_runs
  ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN source_run_key VARCHAR(160);

ALTER TABLE procurement.purchase_recommendation_runs
  ADD CONSTRAINT purchase_recommendation_runs_source_chk
    CHECK (source IN ('manual', 'auto_draft', 'api'));

CREATE UNIQUE INDEX purchase_recommendation_runs_source_key_uidx
  ON procurement.purchase_recommendation_runs (source, source_run_key)
  WHERE source_run_key IS NOT NULL;

COMMENT ON COLUMN procurement.purchase_recommendation_runs.source IS
  'Calculation initiator. Auto-draft runs persist recommendations before any PO mutation.';
COMMENT ON COLUMN procurement.purchase_recommendation_runs.source_run_key IS
  'Source-scoped idempotency key, such as the durable auto-draft run ID.';
