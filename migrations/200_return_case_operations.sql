ALTER TABLE returns.return_cases
  DROP CONSTRAINT IF EXISTS return_cases_logistics_status_chk,
  DROP CONSTRAINT IF EXISTS return_cases_inspection_status_chk;

ALTER TABLE returns.return_cases
  ADD CONSTRAINT return_cases_logistics_status_chk CHECK (
    logistics_status IN (
      'not_required', 'awaiting_return', 'label_ready', 'in_transit',
      'delivered', 'partially_received', 'received'
    )
  ),
  ADD CONSTRAINT return_cases_inspection_status_chk CHECK (
    inspection_status IN (
      'not_required', 'pending', 'in_progress', 'approved', 'rejected'
    )
  );

CREATE TABLE returns.return_case_inspections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL
    REFERENCES returns.return_cases(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL,
  started_at timestamptz NOT NULL,
  started_by varchar(255) NOT NULL,
  completed_at timestamptz,
  completed_by varchar(255),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_inspections_status_chk CHECK (
    status IN ('in_progress', 'approved', 'rejected', 'cancelled')
  ),
  CONSTRAINT return_case_inspections_completion_chk CHECK (
    (status = 'in_progress' AND completed_at IS NULL AND completed_by IS NULL)
    OR
    (status <> 'in_progress' AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
  ),
  CONSTRAINT return_case_inspections_time_chk CHECK (
    completed_at IS NULL OR completed_at >= started_at
  )
);

CREATE UNIQUE INDEX return_case_inspections_active_uq
  ON returns.return_case_inspections (return_case_id)
  WHERE status = 'in_progress';

CREATE INDEX return_case_inspections_case_idx
  ON returns.return_case_inspections (return_case_id, started_at, id);

CREATE TABLE returns.return_case_commands (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL
    REFERENCES returns.return_cases(id) ON DELETE CASCADE,
  command_type varchar(50) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  response jsonb NOT NULL,
  actor varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_commands_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT return_case_commands_type_chk CHECK (
    command_type IN ('record_receipt', 'start_inspection')
  ),
  CONSTRAINT return_case_commands_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT return_case_commands_response_chk CHECK (
    jsonb_typeof(response) = 'object'
  )
);

CREATE INDEX return_case_commands_case_idx
  ON returns.return_case_commands (return_case_id, created_at, id);

CREATE OR REPLACE FUNCTION returns.reject_return_case_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'return_case_commands is append-only command evidence; % is not allowed',
    TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER return_case_commands_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_commands
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_command_mutation();
