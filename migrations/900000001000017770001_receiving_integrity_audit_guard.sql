-- Preserve source and bulk-location decisions without changing unrelated
-- legacy audit actions. Once protected evidence exists, TRUNCATE must fail
-- because it cannot retain individual rows.
CREATE FUNCTION public.guard_receiving_integrity_audit_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected_actions CONSTANT text[] := ARRAY[
    'procurement.receiving.source_resolved',
    'procurement.receiving.default_location_applied'
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

CREATE TRIGGER receiving_integrity_audit_immutable_rows
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.guard_receiving_integrity_audit_history();

CREATE TRIGGER receiving_integrity_audit_immutable_truncate
BEFORE TRUNCATE ON public.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_receiving_integrity_audit_history();
