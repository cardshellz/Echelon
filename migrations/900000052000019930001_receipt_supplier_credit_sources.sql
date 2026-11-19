-- Receipt-attributed supplier credits. Existing economics and approvals are not rewritten.
-- The existing unique key distinguishes different receipts on the same note.
-- Old component/return keys retain their exact original bytes.
CREATE FUNCTION procurement.supplier_credit_line_source_key(disposition jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE assignment jsonb; field text; amount numeric; result text;
BEGIN
 IF disposition ? 'receiptAllocation' AND disposition->>'kind' IS DISTINCT FROM 'price_reduction'
 THEN RAISE EXCEPTION 'Receipt attribution requires a goods price credit' USING ERRCODE='23514'; END IF;
 IF disposition->>'kind'='price_reduction' THEN
  result:='price_reduction:'||(disposition->>'component');
  IF NOT (disposition ? 'receiptAllocation') THEN RETURN result; END IF;
  assignment:=disposition->'receiptAllocation';
  IF coalesce(disposition->>'component','') NOT IN ('product','packaging') OR jsonb_typeof(assignment) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'Receipt credits require an explicit goods assignment' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(assignment))<>4
  THEN RAISE EXCEPTION 'Receipt credit assignment fields are invalid' USING ERRCODE='23514'; END IF;
  FOREACH field IN ARRAY ARRAY['receivingLineId','receiptStartPiece','invoiceStartPiece','pieces'] LOOP
   IF jsonb_typeof(assignment->field) IS DISTINCT FROM 'number'
   THEN RAISE EXCEPTION 'Receipt credit assignment requires exact integers' USING ERRCODE='23514'; END IF;
   amount:=(assignment->>field)::numeric;
   IF amount<>trunc(amount) OR amount<0 OR amount>9007199254740991
    OR (field IN ('receivingLineId','pieces') AND amount=0) OR (field='receivingLineId' AND amount>2147483647)
   THEN RAISE EXCEPTION 'Receipt credit assignment is outside supported bounds' USING ERRCODE='23514'; END IF;
   result:=result||':'||(amount::bigint)::text;
  END LOOP;
  IF (assignment->>'receiptStartPiece')::numeric+(assignment->>'pieces')::numeric>9007199254740991
   OR (assignment->>'invoiceStartPiece')::numeric+(assignment->>'pieces')::numeric>9007199254740991
  THEN RAISE EXCEPTION 'Receipt credit interval is outside supported bounds' USING ERRCODE='23514'; END IF;
  RETURN result;
 ELSIF disposition->>'kind'='quarantine_return' THEN
  RETURN 'quarantine_return:'||(disposition->>'returnDispositionId');
 ELSIF disposition->>'kind'='accepted_stock_return' THEN
  RETURN 'accepted_stock_return:'||(disposition->>'supplierReturnLineId')||':'||coalesce(disposition->>'entitlementId','new')||':'||(disposition->>'component');
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION procurement.assert_supplier_credit_receipt_source(source_invoice_line_id integer, disposition jsonb, evidence jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE assignment jsonb;
BEGIN
 IF NOT (disposition ? 'receiptAllocation') THEN RETURN; END IF;
 PERFORM procurement.supplier_credit_line_source_key(disposition);
 assignment:=disposition->'receiptAllocation';
 IF evidence->'receiptAllocation' IS DISTINCT FROM assignment
 THEN RAISE EXCEPTION 'Receipt credit must retain its reviewed assignment' USING ERRCODE='23514'; END IF;
 PERFORM allocation.id FROM procurement.receipt_invoice_cost_allocations allocation
 JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.id=allocation.invoice_line_id
 JOIN procurement.purchase_order_lines po_line ON po_line.id=allocation.purchase_order_line_id
 JOIN procurement.receiving_lines receipt_line ON receipt_line.id=allocation.receiving_line_id
 WHERE allocation.invoice_line_id=source_invoice_line_id
  AND invoice_line.purchase_order_line_id=po_line.id AND po_line.receipt_costing_enabled=1
  AND receipt_line.purchase_order_line_id=po_line.id
  AND allocation.invoice_start_piece+allocation.pieces<=invoice_line.qty_invoiced::numeric
  AND allocation.receiving_line_id=(assignment->>'receivingLineId')::integer
  AND allocation.receipt_start_piece=(assignment->>'receiptStartPiece')::bigint
  AND allocation.invoice_start_piece=(assignment->>'invoiceStartPiece')::bigint
  AND allocation.pieces=(assignment->>'pieces')::bigint
 FOR SHARE OF allocation,invoice_line,po_line,receipt_line;
 IF NOT FOUND THEN RAISE EXCEPTION 'Receipt credit requires its exact saved invoice assignment' USING ERRCODE='23514'; END IF;
END $$;

-- Preserve every existing document, settlement, reversal and immutable-history
-- check from the current owner. Only receipt source admission is extended.
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
       PERFORM procurement.assert_supplier_credit_receipt_source(line.invoice_line_id,line.disposition,line.source_evidence)
         FROM procurement.supplier_credit_lines line WHERE line.supplier_credit_id=NEW.id;
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
       OR NEW.source_key IS DISTINCT FROM procurement.supplier_credit_line_source_key(NEW.disposition) THEN
       RAISE EXCEPTION 'Supplier credit line requires a declared original invoice source' USING ERRCODE='23514'; END IF;
     PERFORM procurement.assert_supplier_credit_receipt_source(NEW.invoice_line_id,NEW.disposition,NEW.source_evidence);
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
