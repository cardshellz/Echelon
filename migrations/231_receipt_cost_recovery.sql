-- Recovery metadata schedules existing immutable receipt-cost requests. It
-- never posts stock, invents a cost source, or changes existing cost evidence.
BEGIN;

CREATE TABLE IF NOT EXISTS procurement.receipt_cost_recovery_jobs (
  request_id bigint PRIMARY KEY REFERENCES procurement.receipt_cost_requests(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('queued','processing','applied','review_required','exhausted')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20 AND attempt_count <= max_attempts),
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state = 'processing' OR (lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS receipt_cost_recovery_due_idx
  ON procurement.receipt_cost_recovery_jobs(next_attempt_at,request_id)
  WHERE state IN ('queued','processing');

CREATE TABLE IF NOT EXISTS procurement.receipt_cost_recovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES procurement.receipt_cost_recovery_jobs(request_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('claimed','completed','recovered')),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_cost_recovery_events_request_idx
  ON procurement.receipt_cost_recovery_events(request_id,id);

DROP TRIGGER IF EXISTS cost_evidence_immutable ON procurement.receipt_cost_recovery_events;
CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE
  ON procurement.receipt_cost_recovery_events FOR EACH ROW
  EXECUTE FUNCTION inventory.reject_cost_evidence_mutation();

COMMIT;
