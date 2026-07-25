ALTER TABLE procurement.purchase_recommendation_runs
  DROP CONSTRAINT purchase_recommendation_runs_source_chk;

ALTER TABLE procurement.purchase_recommendation_runs
  ADD CONSTRAINT purchase_recommendation_runs_source_chk
  CHECK (source IN ('manual', 'auto_draft', 'api', 'scheduled'));

COMMENT ON COLUMN procurement.purchase_recommendation_runs.source IS
  'Origin of the immutable recommendation snapshot: manual, auto_draft, api, or scheduled.';
