-- Protect existing and future identity.access. command audit evidence.
-- Additive: no prior rows, guards, grants or unrelated actions are rewritten.
-- TRUNCATE requires READ COMMITTED, even when a fixed snapshot sees no history.
-- Runtime-role privilege and access/bootstrap acceptance remain rollout gates.
CREATE FUNCTION public.guard_identity_access_audit_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Identity access audit truncation requires read committed isolation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_events WHERE pg_catalog.starts_with(action, 'identity.access.')) THEN
      RAISE EXCEPTION 'Identity access audit history cannot be truncated' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF pg_catalog.starts_with(OLD.action, 'identity.access.') THEN
    RAISE EXCEPTION 'Identity access audit history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF pg_catalog.starts_with(NEW.action, 'identity.access.') THEN
      RAISE EXCEPTION 'Existing audit rows cannot become identity access history' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER identity_access_audit_history_immutable
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_identity_access_audit_history();
CREATE TRIGGER identity_access_audit_history_truncate_immutable
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_identity_access_audit_history();
