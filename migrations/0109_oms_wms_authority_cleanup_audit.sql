-- Phase 4 readiness cleanup audit trail.
--
-- Historical OMS/WMS authority cleanup needs to remove or repair invalid
-- pre-constraint rows before FK/CHECK constraints can be validated. This table
-- stores immutable row snapshots for those cleanup operations so no cleanup is
-- silent or unauditable.

CREATE TABLE IF NOT EXISTS wms.oms_wms_authority_cleanup_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL,
  operation VARCHAR(80) NOT NULL,
  source_table VARCHAR(120) NOT NULL,
  source_id BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL,
  reason TEXT NOT NULL,
  before_row JSONB NOT NULL,
  after_row JSONB,
  operator VARCHAR(120) NOT NULL DEFAULT 'script:cleanup-oms-wms-authority-readiness',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oms_wms_authority_cleanup_audit_run
  ON wms.oms_wms_authority_cleanup_audit (run_id, operation);

CREATE INDEX IF NOT EXISTS idx_oms_wms_authority_cleanup_audit_source
  ON wms.oms_wms_authority_cleanup_audit (source_table, source_id);
