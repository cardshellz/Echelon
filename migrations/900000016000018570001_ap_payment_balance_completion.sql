-- Preserve historical timestamps and allocations. No data is rewritten.
ALTER TABLE procurement.ap_payments ADD COLUMN IF NOT EXISTS payment_calendar_date date;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='procurement.ap_payments'::regclass AND conname='ap_payment_calendar_date_matches_timestamp') THEN
    ALTER TABLE procurement.ap_payments ADD CONSTRAINT ap_payment_calendar_date_matches_timestamp
      CHECK (payment_calendar_date IS NULL OR payment_date=payment_calendar_date::timestamp) NOT VALID;
  END IF;
END $$;
DROP INDEX IF EXISTS procurement.ap_payment_allocations_pay_inv_idx;
CREATE INDEX IF NOT EXISTS ap_payment_allocations_pay_inv_lookup_idx
  ON procurement.ap_payment_allocations(ap_payment_id, vendor_invoice_id);
COMMENT ON COLUMN procurement.ap_payments.payment_calendar_date IS
  'Explicit operator calendar date for new date-only requests. NULL means historical or legacy timestamp input; do not infer a verified date.';

CREATE OR REPLACE FUNCTION procurement.lock_ap_payment_graph() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ap_payment_allocations_graph_lock ON procurement.ap_payment_allocations;
CREATE TRIGGER ap_payment_allocations_graph_lock BEFORE INSERT OR UPDATE OR DELETE ON procurement.ap_payment_allocations
FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph();
DROP TRIGGER IF EXISTS ap_payments_graph_lock ON procurement.ap_payments;
CREATE TRIGGER ap_payments_graph_lock BEFORE UPDATE OR DELETE ON procurement.ap_payments
FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph();

CREATE OR REPLACE FUNCTION procurement.guard_ap_payment_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment procurement.ap_payments%ROWTYPE; invoice procurement.vendor_invoices%ROWTYPE; applied numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'AP payment applications are immutable; preserve their history' USING ERRCODE='23514'; END IF;
  SELECT * INTO payment FROM procurement.ap_payments WHERE id=NEW.ap_payment_id FOR UPDATE;
  SELECT * INTO invoice FROM procurement.vendor_invoices WHERE id=NEW.vendor_invoice_id FOR UPDATE;
  IF payment.id IS NULL OR invoice.id IS NULL OR payment.status <> 'completed' OR payment.currency <> 'USD'
    OR invoice.currency <> payment.currency OR invoice.vendor_id <> payment.vendor_id
    OR invoice.status NOT IN ('approved','partially_paid')
    OR NEW.applied_amount_cents <= 0 OR NEW.applied_amount_cents > 9007199254740991
    OR payment.total_amount_cents <= 0 OR payment.total_amount_cents > 9007199254740991 THEN
    RAISE EXCEPTION 'AP payment application requires compatible completed payment and approved invoice evidence' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM procurement.ap_payment_allocations a
    LEFT JOIN procurement.vendor_invoices i ON i.id=a.vendor_invoice_id
    WHERE a.ap_payment_id=payment.id AND (a.applied_amount_cents <= 0 OR a.applied_amount_cents > 9007199254740991
      OR i.id IS NULL OR i.vendor_id <> payment.vendor_id OR i.currency <> payment.currency
      OR i.status NOT IN ('approved','partially_paid','paid','disputed'))) THEN
    RAISE EXCEPTION 'Existing AP applications require review' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(applied_amount_cents),0) INTO applied FROM procurement.ap_payment_allocations WHERE ap_payment_id=payment.id;
  IF applied < 0 OR applied + NEW.applied_amount_cents > payment.total_amount_cents THEN
    RAISE EXCEPTION 'AP payment applications exceed the recorded payment' USING ERRCODE='23514';
  END IF;
  -- Do not net invalid historical rows into a plausible target-invoice sum.
  -- This protects both the new application owner and existing payment recording.
  IF invoice.invoiced_amount_cents IS NULL OR invoice.invoiced_amount_cents < 0
    OR invoice.invoiced_amount_cents > 9007199254740991
    OR EXISTS (SELECT 1 FROM procurement.ap_payment_allocations a
      LEFT JOIN procurement.ap_payments p ON p.id=a.ap_payment_id
      WHERE a.vendor_invoice_id=invoice.id AND (
        a.applied_amount_cents IS NULL OR a.applied_amount_cents <= 0 OR a.applied_amount_cents > 9007199254740991
        OR p.id IS NULL OR p.status IS NULL OR p.status NOT IN ('completed','voided')
        OR p.vendor_id IS DISTINCT FROM invoice.vendor_id OR p.currency IS DISTINCT FROM invoice.currency
        OR p.total_amount_cents IS NULL OR p.total_amount_cents <= 0 OR p.total_amount_cents > 9007199254740991)) THEN
    RAISE EXCEPTION 'Invoice payment application evidence requires review' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(a.applied_amount_cents),0) INTO applied
    FROM procurement.ap_payment_allocations a JOIN procurement.ap_payments p ON p.id=a.ap_payment_id
    WHERE a.vendor_invoice_id=invoice.id AND p.status='completed';
  IF applied + NEW.applied_amount_cents > invoice.invoiced_amount_cents THEN
    RAISE EXCEPTION 'AP payment applications exceed the invoice amount' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ap_payment_application_guard ON procurement.ap_payment_allocations;
CREATE TRIGGER ap_payment_application_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.ap_payment_allocations
FOR EACH ROW EXECUTE FUNCTION procurement.guard_ap_payment_application();

CREATE OR REPLACE FUNCTION procurement.guard_ap_payment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP='DELETE' THEN
    RAISE EXCEPTION 'AP payment history cannot be erased' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.vendor_id, NEW.total_amount_cents, NEW.currency, NEW.payment_date, NEW.payment_calendar_date)
    IS DISTINCT FROM ROW(OLD.vendor_id, OLD.total_amount_cents, OLD.currency, OLD.payment_date, OLD.payment_calendar_date) THEN
    RAISE EXCEPTION 'Recorded payment amount, owner, currency and dates are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='voided' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Voided payments cannot be restored' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ap_payment_history_guard ON procurement.ap_payments;
CREATE TRIGGER ap_payment_history_guard BEFORE UPDATE OR DELETE ON procurement.ap_payments
FOR EACH ROW EXECUTE FUNCTION procurement.guard_ap_payment_history();
DROP TRIGGER IF EXISTS ap_payment_no_truncate ON procurement.ap_payments;
CREATE TRIGGER ap_payment_no_truncate BEFORE TRUNCATE ON procurement.ap_payments
FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_ap_payment_history();
DROP TRIGGER IF EXISTS ap_payment_allocations_no_truncate ON procurement.ap_payment_allocations;
CREATE TRIGGER ap_payment_allocations_no_truncate BEFORE TRUNCATE ON procurement.ap_payment_allocations
FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_ap_payment_history();

-- New AP commands share one key namespace; protect coexistence with old application
-- instances without changing any other financial command family or historical row.
CREATE OR REPLACE FUNCTION procurement.guard_ap_payment_command_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_name NOT IN ('ap.payment.record','ap.payment.apply','ap.payment.void','procurement.ap.payment') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('procurement.ap-payment.command-key'), hashtext(NEW.idempotency_key));
  IF EXISTS (SELECT 1 FROM public.financial_command_results c WHERE c.idempotency_key=NEW.idempotency_key
    AND c.command_name IN ('ap.payment.record','ap.payment.apply','ap.payment.void','procurement.ap.payment')
    AND ROW(c.actor_type,c.actor_id,c.method,c.route_template,c.resource_key)
      IS DISTINCT FROM ROW(NEW.actor_type,NEW.actor_id,NEW.method,NEW.route_template,NEW.resource_key)) THEN
    RAISE EXCEPTION 'AP payment request key already belongs to another recorded command identity' USING ERRCODE='23514', CONSTRAINT='financial_command_ap_payment_identity_guard';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS financial_command_ap_payment_identity_guard ON public.financial_command_results;
CREATE TRIGGER financial_command_ap_payment_identity_guard BEFORE INSERT ON public.financial_command_results
FOR EACH ROW EXECUTE FUNCTION procurement.guard_ap_payment_command_identity();
