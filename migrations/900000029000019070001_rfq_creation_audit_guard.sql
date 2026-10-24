-- Protect RFQ creation and its supplier-catalog side effects without rewriting
-- existing audit rows. This guard also protects legacy creation evidence.
CREATE OR REPLACE FUNCTION public.guard_rfq_creation_audit_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected_actions CONSTANT text[] := ARRAY[
    'purchase_rfq.batch_created',
    'purchase_rfq.allocation_override_approved',
    'vendor_catalog.rfq_created',
    'vendor_catalog.rfq_updated',
    'vendor_catalog.rfq_preferred_demoted'
  ];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.audit_events WHERE action = ANY(protected_actions)) THEN
      RAISE EXCEPTION 'RFQ creation audit history cannot be truncated' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.action = ANY(protected_actions) THEN
    RAISE EXCEPTION 'RFQ creation audit history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.action = ANY(protected_actions) THEN
      RAISE EXCEPTION 'Existing audit rows cannot be rewritten as RFQ creation history' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS rfq_creation_audit_history_immutable ON public.audit_events;
CREATE TRIGGER rfq_creation_audit_history_immutable
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.guard_rfq_creation_audit_history();

DROP TRIGGER IF EXISTS rfq_creation_audit_history_truncate_immutable ON public.audit_events;
CREATE TRIGGER rfq_creation_audit_history_truncate_immutable
BEFORE TRUNCATE ON public.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_rfq_creation_audit_history();
