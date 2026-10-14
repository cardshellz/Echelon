-- Revision evidence for atomic procurement policy commands. Existing business
-- policy values are preserved; no DEFAULT row or approval choice is invented.
ALTER TABLE inventory.warehouse_settings
  ADD COLUMN procurement_policy_revision integer NOT NULL DEFAULT 0;

ALTER TABLE inventory.warehouse_settings
  ADD CONSTRAINT warehouse_settings_procurement_policy_revision_chk
  CHECK (procurement_policy_revision >= 0);

-- Retain the evidence for this policy owner without changing the edit/delete
-- semantics of unrelated legacy audit actions. Once protected history exists,
-- TRUNCATE must fail for the whole table because it cannot retain selected rows.
CREATE FUNCTION public.guard_procurement_settings_audit_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.audit_events WHERE action = 'procurement.settings.updated') THEN
      RAISE EXCEPTION 'Procurement settings audit history cannot be truncated' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.action = 'procurement.settings.updated' THEN
    RAISE EXCEPTION 'Procurement settings audit history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.action = 'procurement.settings.updated' THEN
      RAISE EXCEPTION 'Existing audit rows cannot be rewritten as procurement settings history' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER procurement_settings_audit_immutable_rows
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.guard_procurement_settings_audit_history();

CREATE TRIGGER procurement_settings_audit_immutable_truncate
BEFORE TRUNCATE ON public.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_procurement_settings_audit_history();
