-- Dependency: 900000010000018200001_receiving_discard_audit_guard.sql.
-- Protect the immutable before/after evidence of manual creation and Add Line.
-- Existing receiving decisions and every historical audit row remain unchanged.
CREATE OR REPLACE FUNCTION public.guard_receiving_integrity_audit_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected_actions CONSTANT text[] := ARRAY[
    'procurement.receiving.source_resolved',
    'procurement.receiving.default_location_applied',
    'procurement.receiving.discard',
    'procurement.receiving.entry.create',
    'procurement.receiving.entry.add-line'
  ];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.audit_events WHERE action = ANY(protected_actions)) THEN
      RAISE EXCEPTION 'Receiving integrity audit history cannot be truncated' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.action = ANY(protected_actions) THEN
    RAISE EXCEPTION 'Receiving integrity audit history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.action = ANY(protected_actions) THEN
      RAISE EXCEPTION 'Existing audit rows cannot be rewritten as receiving integrity history' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
