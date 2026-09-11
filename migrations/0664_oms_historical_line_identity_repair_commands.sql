CREATE TABLE IF NOT EXISTS oms.historical_order_line_identity_repair_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  wms_order_id INTEGER NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  preview_hash VARCHAR(64) NOT NULL,
  operator VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'claim_pending',
  target_oms_line_ids JSONB NOT NULL,
  repair_result JSONB NOT NULL,
  claim_result JSONB,
  last_error_code VARCHAR(100),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT oms_hist_line_identity_repair_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oms_hist_line_identity_repair_preview_hash_chk
    CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oms_hist_line_identity_repair_status_chk
    CHECK (status IN ('claim_pending', 'succeeded', 'failed')),
  CONSTRAINT oms_hist_line_identity_repair_target_lines_chk
    CHECK (jsonb_typeof(target_oms_line_ids) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS oms_hist_line_identity_repair_idempotency_uidx
  ON oms.historical_order_line_identity_repair_commands(idempotency_key);

CREATE INDEX IF NOT EXISTS oms_hist_line_identity_repair_order_idx
  ON oms.historical_order_line_identity_repair_commands(oms_order_id, created_at);

CREATE INDEX IF NOT EXISTS oms_hist_line_identity_repair_status_idx
  ON oms.historical_order_line_identity_repair_commands(status, updated_at);
