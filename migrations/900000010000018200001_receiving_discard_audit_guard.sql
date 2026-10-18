-- Extend the existing receiving audit guard without changing deployed SQL or
-- historical rows. A discarded standalone draft retains only this snapshot.
-- Dependency: 900000001000017770001_receiving_integrity_audit_guard.sql.
CREATE OR REPLACE FUNCTION public.guard_receiving_integrity_audit_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected_actions CONSTANT text[] := ARRAY[
    'procurement.receiving.source_resolved',
    'procurement.receiving.default_location_applied',
    'procurement.receiving.discard'
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
