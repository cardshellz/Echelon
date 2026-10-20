-- Explicit supplier credit documents and append-only noncash settlement.
-- Existing invoice gross amounts, payment cash history and prior timestamps are not rewritten.
ALTER TABLE procurement.vendor_invoices ADD COLUMN IF NOT EXISTS credited_amount_cents bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS procurement.supplier_credits (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_invoice_id integer NOT NULL REFERENCES procurement.vendor_invoices(id) ON DELETE RESTRICT,
 vendor_id integer NOT NULL REFERENCES procurement.vendors(id) ON DELETE RESTRICT,
 source_snapshot jsonb NOT NULL,
 replaces_credit_id integer REFERENCES procurement.supplier_credits(id) ON DELETE RESTRICT,
 supplier_reference varchar(100) NOT NULL CHECK(length(btrim(supplier_reference))>0 AND supplier_reference=btrim(supplier_reference)),
 credit_calendar_date date NOT NULL,
 total_amount_cents bigint NOT NULL CHECK(total_amount_cents BETWEEN 1 AND 9007199254740991),
 currency varchar(3) NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','voided')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), reason text NOT NULL CHECK(length(btrim(reason))>=3),
 created_by varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL,
 approved_by varchar REFERENCES identity.users(id) ON DELETE RESTRICT,approved_at timestamptz,
 voided_by varchar REFERENCES identity.users(id) ON DELETE RESTRICT,voided_at timestamptz,void_reason text,
 CHECK((approved_by IS NULL)=(approved_at IS NULL)),
 CHECK(status<>'approved' OR approved_by IS NOT NULL),
 CHECK(status<>'voided' OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND length(btrim(void_reason))>=3))
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_credits_vendor_reference_idx ON procurement.supplier_credits(vendor_id,supplier_reference) WHERE status<>'voided';
CREATE UNIQUE INDEX IF NOT EXISTS supplier_credits_replacement_idx ON procurement.supplier_credits(replaces_credit_id);
CREATE INDEX IF NOT EXISTS supplier_credits_source_idx ON procurement.supplier_credits(source_invoice_id);
CREATE TABLE IF NOT EXISTS procurement.supplier_credit_lines (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_credit_id integer NOT NULL REFERENCES procurement.supplier_credits(id) ON DELETE RESTRICT,
 invoice_line_id integer NOT NULL REFERENCES procurement.vendor_invoice_lines(id) ON DELETE RESTRICT,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
 source_key text NOT NULL, disposition jsonb NOT NULL, source_evidence jsonb NOT NULL DEFAULT '{}',
 cost_state varchar(30) NOT NULL DEFAULT 'pending' CHECK(cost_state IN ('pending','posted','review_required')),
 cost_issues jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_credit_lines_source_idx ON procurement.supplier_credit_lines(supplier_credit_id,invoice_line_id,source_key);
CREATE TABLE IF NOT EXISTS procurement.supplier_credit_applications (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_credit_id integer NOT NULL REFERENCES procurement.supplier_credits(id) ON DELETE RESTRICT,
 vendor_invoice_id integer NOT NULL REFERENCES procurement.vendor_invoices(id) ON DELETE RESTRICT,
 applied_amount_cents bigint NOT NULL CHECK(applied_amount_cents BETWEEN 1 AND 9007199254740991),
 actor_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,recorded_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3)
);
CREATE INDEX IF NOT EXISTS supplier_credit_applications_invoice_idx ON procurement.supplier_credit_applications(vendor_invoice_id);
CREATE INDEX IF NOT EXISTS supplier_credit_applications_credit_idx ON procurement.supplier_credit_applications(supplier_credit_id);
CREATE TABLE IF NOT EXISTS procurement.supplier_credit_application_reversals (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 application_id integer NOT NULL REFERENCES procurement.supplier_credit_applications(id) ON DELETE RESTRICT,
 actor_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,recorded_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_credit_reversals_application_idx ON procurement.supplier_credit_application_reversals(application_id);

CREATE OR REPLACE FUNCTION procurement.supplier_credit_invoice_amount(invoice_id integer) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
 IF EXISTS(SELECT 1 FROM procurement.supplier_credit_applications a
   LEFT JOIN procurement.supplier_credits c ON c.id=a.supplier_credit_id
   LEFT JOIN procurement.vendor_invoices i ON i.id=a.vendor_invoice_id
   LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id
   WHERE a.vendor_invoice_id=invoice_id AND (c.id IS NULL OR i.id IS NULL OR c.currency IS DISTINCT FROM i.currency
     OR c.vendor_id IS DISTINCT FROM i.vendor_id OR a.applied_amount_cents NOT BETWEEN 1 AND 9007199254740991
     OR c.total_amount_cents NOT BETWEEN 1 AND 9007199254740991 OR c.status NOT IN ('approved','voided')
     OR (r.id IS NULL AND c.status<>'approved')
     OR c.total_amount_cents IS DISTINCT FROM (SELECT sum(l.amount_cents) FROM procurement.supplier_credit_lines l WHERE l.supplier_credit_id=c.id)
     OR EXISTS(SELECT 1 FROM procurement.supplier_credit_lines l WHERE l.supplier_credit_id=c.id AND l.amount_cents NOT BETWEEN 1 AND 9007199254740991)
     OR c.total_amount_cents < (SELECT coalesce(sum(x.applied_amount_cents),0) FROM procurement.supplier_credit_applications x
        LEFT JOIN procurement.supplier_credit_application_reversals xr ON xr.application_id=x.id WHERE x.supplier_credit_id=c.id AND xr.id IS NULL))) THEN
   RAISE EXCEPTION 'Supplier credit application evidence requires review' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(a.applied_amount_cents),0) INTO total FROM procurement.supplier_credit_applications a
   LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id WHERE a.vendor_invoice_id=invoice_id AND r.id IS NULL;
 RETURN total;
END $$;
CREATE OR REPLACE FUNCTION procurement.supplier_credit_cash_amount(invoice_id integer) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE invoice procurement.vendor_invoices%ROWTYPE; total numeric;
BEGIN
 SELECT * INTO invoice FROM procurement.vendor_invoices WHERE id=invoice_id FOR UPDATE;
 IF invoice.id IS NULL OR invoice.invoiced_amount_cents NOT BETWEEN 0 AND 9007199254740991
   OR EXISTS(SELECT 1 FROM procurement.ap_payment_allocations a LEFT JOIN procurement.ap_payments p ON p.id=a.ap_payment_id
      WHERE a.vendor_invoice_id=invoice_id AND (a.applied_amount_cents NOT BETWEEN 1 AND 9007199254740991 OR p.id IS NULL
       OR p.status NOT IN ('completed','voided') OR p.vendor_id IS DISTINCT FROM invoice.vendor_id OR p.currency IS DISTINCT FROM invoice.currency
       OR p.total_amount_cents NOT BETWEEN 1 AND 9007199254740991
       OR p.total_amount_cents < (SELECT coalesce(sum(pa.applied_amount_cents),0) FROM procurement.ap_payment_allocations pa WHERE pa.ap_payment_id=p.id))) THEN
   RAISE EXCEPTION 'Invoice cash settlement evidence requires review' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(a.applied_amount_cents),0) INTO total FROM procurement.ap_payment_allocations a
   JOIN procurement.ap_payments p ON p.id=a.ap_payment_id WHERE a.vendor_invoice_id=invoice_id AND p.status='completed';
 RETURN total;
END $$;
CREATE OR REPLACE FUNCTION procurement.guard_supplier_credit_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source procurement.vendor_invoices%ROWTYPE; credit procurement.supplier_credits%ROWTYPE; invoice procurement.vendor_invoices%ROWTYPE; applied numeric;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Supplier credit history cannot be erased' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='supplier_credits' THEN
   IF TG_OP='INSERT' THEN
     SELECT * INTO source FROM procurement.vendor_invoices WHERE id=NEW.source_invoice_id FOR UPDATE;
     IF NEW.replaces_credit_id IS NOT NULL THEN
       IF NOT EXISTS(SELECT 1 FROM procurement.supplier_credits c WHERE c.id=NEW.replaces_credit_id AND c.status='voided' AND c.vendor_id=NEW.vendor_id AND c.supplier_reference=NEW.supplier_reference) THEN
         RAISE EXCEPTION 'Supplier credit replacement needs the exact voided supplier document' USING ERRCODE='23514'; END IF;
     ELSIF EXISTS(SELECT 1 FROM procurement.supplier_credits c WHERE c.vendor_id=NEW.vendor_id AND c.supplier_reference=NEW.supplier_reference) THEN
       RAISE EXCEPTION 'Use explicit supplier credit replacement to retain duplicate reference history' USING ERRCODE='23514'; END IF;
     IF source.id IS NULL OR source.vendor_id<>NEW.vendor_id OR source.currency<>NEW.currency OR source.status NOT IN ('approved','partially_paid','paid') OR NEW.status<>'draft' OR NEW.version<>1 OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
       RAISE EXCEPTION 'Supplier credit needs a compatible approved original invoice' USING ERRCODE='23514'; END IF;
   ELSE
     IF NEW.version<>OLD.version+1 OR (NEW.status='draft' AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL))
       OR (NEW.status<>'voided' AND (NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL)) THEN
       RAISE EXCEPTION 'Supplier credit versions and status history must advance explicitly' USING ERRCODE='23514'; END IF;
     IF ROW(NEW.source_invoice_id,NEW.vendor_id,NEW.source_snapshot,NEW.replaces_credit_id,NEW.supplier_reference,NEW.credit_calendar_date,NEW.total_amount_cents,NEW.currency,NEW.reason,NEW.created_by,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.source_invoice_id,OLD.vendor_id,OLD.source_snapshot,OLD.replaces_credit_id,OLD.supplier_reference,OLD.credit_calendar_date,OLD.total_amount_cents,OLD.currency,OLD.reason,OLD.created_by,OLD.created_at)
       OR (OLD.status='voided' AND NEW IS DISTINCT FROM OLD) OR (OLD.status='approved' AND NEW.status NOT IN ('approved','voided'))
       OR (OLD.approved_at IS NOT NULL AND ROW(NEW.approved_by,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at)) THEN
       RAISE EXCEPTION 'Supplier credit economics and approval history are immutable' USING ERRCODE='23514'; END IF;
     IF NEW.status='approved' AND OLD.status='draft' THEN
       IF NEW.total_amount_cents IS DISTINCT FROM (SELECT sum(amount_cents) FROM procurement.supplier_credit_lines WHERE supplier_credit_id=NEW.id) THEN
         RAISE EXCEPTION 'Credit document and source lines do not conserve amount' USING ERRCODE='23514'; END IF;
       IF EXISTS(SELECT l.invoice_line_id FROM procurement.supplier_credit_lines l
          JOIN procurement.supplier_credits c ON c.id=l.supplier_credit_id
          JOIN procurement.vendor_invoice_lines il ON il.id=l.invoice_line_id
          WHERE c.source_invoice_id=NEW.source_invoice_id AND (c.status='approved' OR c.id=NEW.id)
          GROUP BY l.invoice_line_id,il.line_total_cents
          HAVING sum(l.amount_cents)>il.line_total_cents) THEN
         RAISE EXCEPTION 'Approved credits exceed original source line amount' USING ERRCODE='23514'; END IF;
     END IF;
     IF NEW.status='voided' AND EXISTS(SELECT 1 FROM procurement.supplier_credit_applications a LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id WHERE a.supplier_credit_id=NEW.id AND r.id IS NULL) THEN
       RAISE EXCEPTION 'Reverse active applications before voiding supplier credit' USING ERRCODE='23514'; END IF;
   END IF;
 ELSIF TG_TABLE_NAME='supplier_credit_lines' THEN
   SELECT * INTO credit FROM procurement.supplier_credits WHERE id=NEW.supplier_credit_id FOR UPDATE;
   IF TG_OP='INSERT' THEN
     IF credit.status<>'draft' OR NOT EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines l WHERE l.id=NEW.invoice_line_id AND l.vendor_invoice_id=credit.source_invoice_id)
       OR NEW.source_key IS DISTINCT FROM (CASE WHEN NEW.disposition->>'kind'='price_reduction' THEN 'price_reduction:'||(NEW.disposition->>'component') WHEN NEW.disposition->>'kind'='quarantine_return' THEN 'quarantine_return:'||(NEW.disposition->>'returnDispositionId') END) THEN
       RAISE EXCEPTION 'Supplier credit line requires a declared original invoice source' USING ERRCODE='23514'; END IF;
   ELSIF ROW(NEW.supplier_credit_id,NEW.invoice_line_id,NEW.amount_cents,NEW.source_key,NEW.disposition,NEW.source_evidence,NEW.created_at) IS DISTINCT FROM ROW(OLD.supplier_credit_id,OLD.invoice_line_id,OLD.amount_cents,OLD.source_key,OLD.disposition,OLD.source_evidence,OLD.created_at) THEN
     RAISE EXCEPTION 'Supplier credit line economics are immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='supplier_credit_applications' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Credit applications are append only' USING ERRCODE='23514'; END IF;
   SELECT * INTO credit FROM procurement.supplier_credits WHERE id=NEW.supplier_credit_id FOR UPDATE;
   SELECT * INTO invoice FROM procurement.vendor_invoices WHERE id=NEW.vendor_invoice_id FOR UPDATE;
   IF credit.id IS NULL OR invoice.id IS NULL OR credit.status<>'approved' OR invoice.status NOT IN ('approved','partially_paid')
     OR credit.vendor_id<>invoice.vendor_id OR credit.currency<>invoice.currency OR NEW.applied_amount_cents NOT BETWEEN 1 AND 9007199254740991 THEN
     RAISE EXCEPTION 'Credit application requires compatible approved document and invoice' USING ERRCODE='23514'; END IF;
   SELECT coalesce(sum(a.applied_amount_cents),0) INTO applied FROM procurement.supplier_credit_applications a LEFT JOIN procurement.supplier_credit_application_reversals r ON r.application_id=a.id WHERE a.supplier_credit_id=credit.id AND r.id IS NULL;
   IF applied+NEW.applied_amount_cents>credit.total_amount_cents OR procurement.supplier_credit_cash_amount(invoice.id)+procurement.supplier_credit_invoice_amount(invoice.id)+NEW.applied_amount_cents>invoice.invoiced_amount_cents THEN
     RAISE EXCEPTION 'Credit application exceeds document or invoice remaining amount' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='supplier_credit_application_reversals' THEN
   IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Credit reversals are append only' USING ERRCODE='23514'; END IF;
   SELECT c.* INTO credit FROM procurement.supplier_credits c JOIN procurement.supplier_credit_applications a ON a.supplier_credit_id=c.id WHERE a.id=NEW.application_id FOR UPDATE OF c;
   IF credit.status<>'approved' THEN RAISE EXCEPTION 'Reverse only an approved credit application' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['supplier_credits','supplier_credit_lines','supplier_credit_applications','supplier_credit_application_reversals'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS supplier_credit_graph_lock ON procurement.%I',name);
   EXECUTE format('CREATE TRIGGER supplier_credit_graph_lock BEFORE INSERT OR UPDATE OR DELETE ON procurement.%I FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph()',name);
   EXECUTE format('DROP TRIGGER IF EXISTS supplier_credit_history_guard ON procurement.%I',name);
   EXECUTE format('CREATE TRIGGER supplier_credit_history_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.%I FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_credit_history()',name);
   EXECUTE format('DROP TRIGGER IF EXISTS supplier_credit_no_truncate ON procurement.%I',name);
   EXECUTE format('CREATE TRIGGER supplier_credit_no_truncate BEFORE TRUNCATE ON procurement.%I FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_supplier_credit_history()',name);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION procurement.guard_invoice_credit_source_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='DELETE' OR ROW(NEW.vendor_id,NEW.currency,NEW.invoiced_amount_cents) IS DISTINCT FROM ROW(OLD.vendor_id,OLD.currency,OLD.invoiced_amount_cents) OR NEW.status='voided')
   AND (EXISTS(SELECT 1 FROM procurement.supplier_credits WHERE source_invoice_id=OLD.id) OR EXISTS(SELECT 1 FROM procurement.supplier_credit_applications WHERE vendor_invoice_id=OLD.id)) THEN
   RAISE EXCEPTION 'Invoice with retained supplier credit history cannot be erased, voided or rewritten' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoice_credit_source_history ON procurement.vendor_invoices;
CREATE TRIGGER invoice_credit_source_history BEFORE UPDATE OR DELETE ON procurement.vendor_invoices FOR EACH ROW EXECUTE FUNCTION procurement.guard_invoice_credit_source_history();

-- Retain all pre-existing cash guards; noncash settlement reduces the available invoice balance.
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
  IF applied + procurement.supplier_credit_invoice_amount(invoice.id) + NEW.applied_amount_cents > invoice.invoiced_amount_cents THEN
    RAISE EXCEPTION 'AP payment applications exceed the invoice amount' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Retain the exact invoice economics that established every source credit,
-- including draft and voided history. Operational labels/match notes may change.
CREATE OR REPLACE FUNCTION procurement.guard_credited_invoice_line_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM procurement.supplier_credit_lines WHERE invoice_line_id=OLD.id)
   AND (TG_OP='DELETE' OR ROW(NEW.vendor_invoice_id,NEW.purchase_order_line_id,NEW.freight_cost_id,NEW.product_variant_id,NEW.qty_invoiced,NEW.unit_cost_cents,NEW.unit_cost_mills,NEW.cost_component_evidence,NEW.line_total_cents)
     IS DISTINCT FROM ROW(OLD.vendor_invoice_id,OLD.purchase_order_line_id,OLD.freight_cost_id,OLD.product_variant_id,OLD.qty_invoiced,OLD.unit_cost_cents,OLD.unit_cost_mills,OLD.cost_component_evidence,OLD.line_total_cents)) THEN
   RAISE EXCEPTION 'Invoice source economics with supplier credit history are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS credited_invoice_line_source_guard ON procurement.vendor_invoice_lines;
CREATE TRIGGER credited_invoice_line_source_guard BEFORE UPDATE OR DELETE ON procurement.vendor_invoice_lines FOR EACH ROW EXECUTE FUNCTION procurement.guard_credited_invoice_line_source();

-- Direct invoice writes take the same graph lock before acquiring row locks,
-- so creating a credit and editing its source cannot pass each other.
DROP TRIGGER IF EXISTS invoice_credit_graph_lock ON procurement.vendor_invoices;
CREATE TRIGGER invoice_credit_graph_lock BEFORE UPDATE OR DELETE ON procurement.vendor_invoices FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph();
DROP TRIGGER IF EXISTS invoice_line_credit_graph_lock ON procurement.vendor_invoice_lines;
CREATE TRIGGER invoice_line_credit_graph_lock BEFORE UPDATE OR DELETE ON procurement.vendor_invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph();
