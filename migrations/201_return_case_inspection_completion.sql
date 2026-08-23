ALTER TABLE returns.return_case_inspections
  ADD COLUMN IF NOT EXISTS completion_notes text;

ALTER TABLE returns.return_case_commands
  DROP CONSTRAINT IF EXISTS return_case_commands_type_chk;

ALTER TABLE returns.return_case_commands
  ADD CONSTRAINT return_case_commands_type_chk CHECK (
    command_type IN ('record_receipt', 'start_inspection', 'complete_inspection')
  );

CREATE OR REPLACE FUNCTION returns.guard_return_case_inspection_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.return_case_id IS DISTINCT FROM OLD.return_case_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.started_by IS DISTINCT FROM OLD.started_by
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Return case inspection identity and start evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION
      'Completed return case inspections are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status NOT IN ('approved', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION
      'An in-progress return case inspection may only transition to a terminal status'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.completed_at IS NULL
     OR NEW.completed_by IS NULL
     OR btrim(NEW.completed_by) = '' THEN
    RAISE EXCEPTION
      'A completed return case inspection requires completion actor and time'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS return_case_inspections_mutation_guard
  ON returns.return_case_inspections;
CREATE TRIGGER return_case_inspections_mutation_guard
  BEFORE UPDATE ON returns.return_case_inspections
  FOR EACH ROW EXECUTE FUNCTION returns.guard_return_case_inspection_mutation();
