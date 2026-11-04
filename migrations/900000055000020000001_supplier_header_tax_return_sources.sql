-- supplier_header_tax_return_sources
-- Classify existing supplier amounts through the current cost owners.
-- No bill, payment, quantity, prior review or historical posting is rewritten.
CREATE TABLE procurement.supplier_header_cost_reviews (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 purchase_order_id integer REFERENCES procurement.purchase_orders(id) ON DELETE RESTRICT,
 vendor_invoice_id integer REFERENCES procurement.vendor_invoices(id) ON DELETE RESTRICT,
 source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 source_version varchar(64) NOT NULL CHECK(source_version ~ '^[a-f0-9]{64}$'),
 entries_json jsonb NOT NULL CHECK(jsonb_typeof(entries_json)='array' AND jsonb_array_length(entries_json)<=30),
 before_json jsonb NOT NULL CHECK(jsonb_typeof(before_json)='array'),
 after_json jsonb NOT NULL CHECK(jsonb_typeof(after_json)='array'),
 purchase_order_ids integer[] NOT NULL,
 actor_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
 actor_name text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 approved_at timestamptz NOT NULL,
 command_key varchar(200) NOT NULL CHECK(length(command_key)>0),
 preview_version varchar(64) NOT NULL CHECK(preview_version ~ '^[a-f0-9]{64}$'),
 CONSTRAINT supplier_header_cost_reviews_target_ck CHECK(num_nonnulls(purchase_order_id,vendor_invoice_id)=1)
);
CREATE UNIQUE INDEX supplier_header_cost_reviews_po_command_uq ON procurement.supplier_header_cost_reviews(actor_id,purchase_order_id,command_key) WHERE purchase_order_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_header_cost_reviews_invoice_command_uq ON procurement.supplier_header_cost_reviews(actor_id,vendor_invoice_id,command_key) WHERE vendor_invoice_id IS NOT NULL;
CREATE INDEX supplier_header_cost_reviews_po_idx ON procurement.supplier_header_cost_reviews(purchase_order_id,id DESC);
CREATE INDEX supplier_header_cost_reviews_invoice_idx ON procurement.supplier_header_cost_reviews(vendor_invoice_id,id DESC);

CREATE FUNCTION procurement.guard_supplier_header_cost_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry jsonb; share jsonb; expected numeric; entered numeric:=0; allocated numeric:=0; source_id integer; linked integer[];
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Supplier header approval history cannot be changed or erased' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'));
 IF NEW.purchase_order_id IS NOT NULL THEN
  SELECT (-coalesce(po.discount_cents,0)::numeric+coalesce(po.shipping_cost_cents,0)::numeric
    +coalesce((SELECT sum(CASE WHEN line.line_type='product' THEN -coalesce(line.discount_cents,0)
       WHEN line.line_type='tax' THEN 0 ELSE line.line_total_cents END)
       FROM procurement.purchase_order_lines line WHERE line.purchase_order_id=po.id AND line.status<>'cancelled'),0))::numeric*100
    INTO expected FROM procurement.purchase_orders po WHERE po.id=NEW.purchase_order_id FOR SHARE;
  linked:=ARRAY[NEW.purchase_order_id];
 ELSE
  SELECT (invoice.invoiced_amount_cents-coalesce((SELECT sum(line.line_total_cents)
    FROM procurement.vendor_invoice_lines line WHERE line.vendor_invoice_id=invoice.id),0))::numeric*100
    INTO expected FROM procurement.vendor_invoices invoice WHERE invoice.id=NEW.vendor_invoice_id FOR SHARE;
  SELECT coalesce(array_agg(DISTINCT related.purchase_order_id ORDER BY related.purchase_order_id),'{}'::int[]) INTO linked FROM (
    SELECT po.purchase_order_id FROM procurement.vendor_invoice_lines line
    JOIN procurement.purchase_order_lines po ON po.id=line.purchase_order_line_id WHERE line.vendor_invoice_id=NEW.vendor_invoice_id
    UNION SELECT po.purchase_order_id FROM procurement.vendor_invoice_lines line
    JOIN procurement.inbound_freight_costs charge ON charge.id=line.freight_cost_id
    JOIN procurement.inbound_shipment_lines shipment_line ON shipment_line.inbound_shipment_id=charge.inbound_shipment_id
    JOIN procurement.purchase_order_lines po ON po.id=shipment_line.purchase_order_line_id WHERE line.vendor_invoice_id=NEW.vendor_invoice_id
  ) related;
 END IF;
 IF expected IS NULL OR abs(expected)>9007199254740991 OR cardinality(NEW.purchase_order_ids)>500
   OR NEW.purchase_order_ids IS DISTINCT FROM linked THEN
  RAISE EXCEPTION 'Supplier header source is missing or exceeds its complete review limit' USING ERRCODE='23514'; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.entries_json) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'amountMills') IS DISTINCT FROM 'number' OR (entry->>'amountMills') !~ '^-?[0-9]+$'
    OR abs((entry->>'amountMills')::numeric)>9007199254740991 OR (entry->>'amountMills')::numeric%100<>0
    OR coalesce(entry->>'destination','') NOT IN ('product','packaging','landed','excluded','tax')
    OR coalesce(entry->>'method','') NOT IN ('by_value','manual')
    OR coalesce(entry->>'key','') !~ '^[A-Za-z0-9_-]{1,80}$'
    OR coalesce(entry->>'category','') NOT IN ('discount','supplier_freight','other','tax')
    OR (entry->>'category'='discount' AND (entry->>'amountMills')::numeric>0)
    OR (entry->>'category'='tax' AND (entry->>'destination'<>'tax' OR (entry->>'amountMills')::numeric<0)) THEN
   RAISE EXCEPTION 'Supplier header requires exact classified cent amounts' USING ERRCODE='23514'; END IF;
  entered:=entered+(entry->>'amountMills')::numeric;
 END LOOP;
 FOR share IN SELECT value FROM jsonb_array_elements(NEW.after_json) LOOP
  IF jsonb_typeof(share) IS DISTINCT FROM 'object' OR jsonb_typeof(share->'amountMills') IS DISTINCT FROM 'number' OR (share->>'amountMills') !~ '^-?[0-9]+$'
    OR abs((share->>'amountMills')::numeric)>9007199254740991 OR (share->>'amountMills')::numeric%100<>0
    OR jsonb_typeof(share->'lineId') IS DISTINCT FROM 'number' OR (share->>'lineId') !~ '^[1-9][0-9]*$'
    OR (share->>'lineId')::numeric>2147483647 THEN
   RAISE EXCEPTION 'Supplier header requires exact saved line shares' USING ERRCODE='23514'; END IF;
  source_id:=(share->>'lineId')::integer;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.entries_json) original
    WHERE original->>'key'=share->>'key' AND original->>'destination'=share->>'destination'
      AND (share->>'amountMills')::numeric*(original->>'amountMills')::numeric>=0) THEN
   RAISE EXCEPTION 'Header share must retain its reviewed source, sign and destination' USING ERRCODE='23514'; END IF;
  IF share->>'destination'='tax' THEN
   IF jsonb_typeof(share->'taxTypeId') IS DISTINCT FROM 'number' OR NOT EXISTS(SELECT 1 FROM procurement.purchase_tax_types
      WHERE id::text=share->>'taxTypeId' AND treatment=share->>'taxTreatment') THEN
    RAISE EXCEPTION 'Header tax share must retain its configured treatment' USING ERRCODE='23514'; END IF;
  ELSIF share->>'taxTypeId' IS NOT NULL OR share->>'taxTreatment' IS NOT NULL THEN
   RAISE EXCEPTION 'Only tax shares may declare tax treatment' USING ERRCODE='23514';
  END IF;
  IF NEW.purchase_order_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM procurement.purchase_order_lines WHERE id=source_id AND purchase_order_id=NEW.purchase_order_id AND line_type='product' AND status<>'cancelled') THEN
    RAISE EXCEPTION 'Header share belongs to a different PO source' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines WHERE id=source_id AND vendor_invoice_id=NEW.vendor_invoice_id) THEN
   RAISE EXCEPTION 'Header share belongs to a different invoice source' USING ERRCODE='23514'; END IF;
  allocated:=allocated+(share->>'amountMills')::numeric;
 END LOOP;
 IF (SELECT count(*)<>count(DISTINCT value->>'key') FROM jsonb_array_elements(NEW.entries_json))
   OR (SELECT count(*)<>count(DISTINCT (value->>'key',value->>'lineId')) FROM jsonb_array_elements(NEW.after_json))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.entries_json) original WHERE (original->>'amountMills')::numeric
     <>coalesce((SELECT sum((value->>'amountMills')::numeric) FROM jsonb_array_elements(NEW.after_json) WHERE value->>'key'=original->>'key'),0)) THEN
  RAISE EXCEPTION 'Each unique header source must conserve its own exact shares' USING ERRCODE='23514'; END IF;
 IF entered<>expected OR allocated<>expected THEN
  RAISE EXCEPTION 'Supplier header entries and line shares must conserve the original document amount' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_header_cost_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.supplier_header_cost_reviews
 FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_header_cost_reviews();
CREATE TRIGGER supplier_header_cost_reviews_truncate_guard BEFORE TRUNCATE ON procurement.supplier_header_cost_reviews
 FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_supplier_header_cost_reviews();

CREATE FUNCTION procurement.guard_supplier_header_linked_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_id integer;
BEGIN
 FOREACH purchase_id IN ARRAY NEW.purchase_order_ids LOOP
  IF NOT EXISTS(SELECT 1 FROM procurement.po_events event WHERE event.po_id=purchase_id
    AND event.event_type='supplier_header_costs_approved' AND event.actor_id=NEW.actor_id
    AND event.payload_json->>'headerReviewId'=NEW.id::text
    AND event.payload_json->'preview'->>'previewVersion'=NEW.preview_version
    AND event.payload_json->>'commandKey'=NEW.command_key) THEN
   RAISE EXCEPTION 'Supplier header approval must retain its original linked purchase history' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_header_linked_approval_guard AFTER INSERT ON procurement.supplier_header_cost_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_header_linked_approval();

-- Gross shipment allocations retain a separate, signed non-tax exclusion.
-- Zero defaults preserve all existing economic source identities.
ALTER TABLE procurement.landed_cost_snapshots ADD COLUMN IF NOT EXISTS excluded_supplier_allocated_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE procurement.landed_cost_snapshots ADD CONSTRAINT landed_cost_supplier_exclusion_bounds
 CHECK (excluded_supplier_allocated_cents BETWEEN -9007199254740991 AND 9007199254740991);

-- Re-evaluate the approved rule against current original invoice lines, just as
-- the application selector does. Saved approval shares remain immutable history.
CREATE FUNCTION procurement.current_supplier_invoice_header_shares(source_invoice_id integer)
RETURNS TABLE(line_id integer,entry_key text,destination text,amount_mills numeric,tax_type_id integer)
LANGUAGE sql STABLE AS $$
 WITH review AS (SELECT entries_json FROM procurement.supplier_header_cost_reviews WHERE vendor_invoice_id=source_invoice_id ORDER BY id DESC LIMIT 1),
 entries AS (SELECT entry FROM review CROSS JOIN LATERAL jsonb_array_elements(entries_json) entry),
 candidates AS (
  SELECT entry,line.id,greatest(line.line_total_cents,0)::numeric AS basis,
   (entry->>'amountMills')::numeric/100 AS cents
  FROM entries CROSS JOIN procurement.vendor_invoice_lines line
  LEFT JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id
  WHERE line.vendor_invoice_id=source_invoice_id AND (
   entry->>'destination'='excluded'
   OR entry->>'destination'='tax' AND (line.freight_cost_id IS NOT NULL OR po_line.line_type='product')
   OR entry->>'destination'='landed' AND line.freight_cost_id IS NOT NULL AND line.purchase_order_line_id IS NULL
   OR entry->>'destination' IN ('product','packaging') AND po_line.line_type='product' AND line.freight_cost_id IS NULL)
 ), weighted AS (
  SELECT *,sum(basis) OVER(PARTITION BY entry->>'key') AS total FROM candidates WHERE entry->>'method'='by_value'
 ), quotas AS (
  SELECT *,CASE WHEN total>0 THEN floor(abs(cents)*basis/total) ELSE 0 END AS floor_cents,
    CASE WHEN total>0 THEN mod(abs(cents)*basis,total) ELSE 0 END AS remainder FROM weighted
 ), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY entry->>'key' ORDER BY remainder DESC,id) AS rank,
    abs(cents)-sum(floor_cents) OVER(PARTITION BY entry->>'key') AS residual FROM quotas
 ), shares AS (
  SELECT id,entry,sign(cents)*(floor_cents+CASE WHEN rank<=residual THEN 1 ELSE 0 END)*100 AS mills
  FROM ranked WHERE total>0 OR cents=0
  UNION ALL
  SELECT candidate.id,candidate.entry,(share->>'amountMills')::numeric
  FROM candidates candidate CROSS JOIN LATERAL jsonb_array_elements(candidate.entry->'shares') share
  WHERE candidate.entry->>'method'='manual' AND (share->>'lineId')::integer=candidate.id
 ) SELECT id,entry->>'key',entry->>'destination',mills,(entry->>'taxTypeId')::integer FROM shares WHERE mills<>0
$$;
CREATE FUNCTION procurement.supplier_invoice_line_credit_capacity(source_line_id integer) RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE source procurement.vendor_invoice_lines%ROWTYPE; difference numeric; total numeric; share numeric;
BEGIN
 SELECT * INTO source FROM procurement.vendor_invoice_lines WHERE id=source_line_id;
 IF source.id IS NULL THEN RAISE EXCEPTION 'Original invoice line is missing' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM procurement.supplier_header_cost_reviews WHERE vendor_invoice_id=source.vendor_invoice_id)
 THEN RETURN source.line_total_cents; END IF;
 SELECT invoice.invoiced_amount_cents-coalesce(sum(line.line_total_cents),0) INTO difference
 FROM procurement.vendor_invoices invoice LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
 WHERE invoice.id=source.vendor_invoice_id GROUP BY invoice.invoiced_amount_cents;
 SELECT coalesce(sum(amount_mills),0),coalesce(sum(amount_mills) FILTER(WHERE line_id=source_line_id),0) INTO total,share
 FROM procurement.current_supplier_invoice_header_shares(source.vendor_invoice_id);
 IF total<>difference*100 THEN RAISE EXCEPTION 'Review current supplier header allocations before crediting their shares' USING ERRCODE='23514'; END IF;
 RETURN source.line_total_cents+share/100;
END $$;

ALTER FUNCTION procurement.supplier_credit_line_source_key(jsonb) RENAME TO supplier_credit_line_source_key_v52;
CREATE FUNCTION procurement.supplier_credit_line_source_key(disposition jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text; receipt_key text; scope jsonb;
BEGIN
 IF disposition->>'kind'='accepted_stock_return' AND disposition ? 'taxRefund' THEN
  PERFORM procurement.supplier_credit_line_source_key(jsonb_build_object('kind','tax_reduction')||(disposition->'taxRefund'));
  RETURN procurement.supplier_credit_line_source_key_v52(disposition)||':tax:'||(disposition->'taxRefund'->>'taxSourceKey');
 END IF;
 IF disposition->>'kind'<>'tax_reduction' THEN RETURN procurement.supplier_credit_line_source_key_v52(disposition); END IF;
 IF jsonb_typeof(disposition->'taxSourceKey') IS DISTINCT FROM 'string' OR length(disposition->>'taxSourceKey') NOT BETWEEN 1 AND 200
  OR jsonb_typeof(disposition->'taxTypeId') IS DISTINCT FROM 'number'
  OR (disposition->>'taxTypeId')::numeric NOT BETWEEN 1 AND 2147483647 OR (disposition->>'taxTypeId')::numeric<>trunc((disposition->>'taxTypeId')::numeric)
  OR disposition ? 'receiptAllocation' AND disposition ? 'quarantineAllocation'
 THEN RAISE EXCEPTION 'Tax credit requires one original tax source and one quantity destination' USING ERRCODE='23514'; END IF;
 result:='tax_reduction:'||(disposition->>'taxSourceKey');
 IF disposition ? 'receiptAllocation' THEN
  receipt_key:=procurement.supplier_credit_line_source_key_v52(jsonb_build_object('kind','price_reduction','component','product','receiptAllocation',disposition->'receiptAllocation'));
  result:=result||substr(receipt_key,length('price_reduction:product')+1);
 ELSIF disposition ? 'quarantineAllocation' THEN
  scope:=disposition->'quarantineAllocation';
  IF jsonb_typeof(scope) IS DISTINCT FROM 'object' OR jsonb_typeof(scope->'invoiceStartPiece') IS DISTINCT FROM 'number'
   OR (scope->>'invoiceStartPiece')::numeric NOT BETWEEN 0 AND 9007199254740991
   OR (scope->>'invoiceStartPiece')::numeric<>trunc((scope->>'invoiceStartPiece')::numeric)
  THEN RAISE EXCEPTION 'Returned tax must identify original billed pieces' USING ERRCODE='23514'; END IF;
  result:=result||':return:'||(scope->>'returnDispositionId')||':'||(scope->>'invoiceStartPiece');
 END IF;
 RETURN result;
END $$;

-- Preserve the full existing financial history and settlement guard.
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
          HAVING sum(l.amount_cents)>procurement.supplier_invoice_line_credit_capacity(l.invoice_line_id)) THEN
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

-- Tax refunds retain their original configured source. Receipt and quarantine
-- scopes are checked independently from settlement; returned goods are not a
-- price reduction on the stock retained.
CREATE FUNCTION procurement.assert_supplier_tax_return_credit(source_line_id integer, disposition jsonb, evidence jsonb, amount bigint, credit_id integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source procurement.vendor_invoice_lines%ROWTYPE; original_tax numeric; expected_tax_key text; refunded numeric;
 scope jsonb; start_piece numeric; pieces numeric; conversion numeric; returned procurement.receiving_quarantine_dispositions%ROWTYPE;
 observation procurement.receiving_quarantine_observations%ROWTYPE; interval_amount numeric; tax_disposition jsonb;
BEGIN
 SELECT * INTO source FROM procurement.vendor_invoice_lines WHERE id=source_line_id FOR SHARE;
 tax_disposition:=CASE WHEN disposition->>'kind'='accepted_stock_return' THEN disposition->'taxRefund' ELSE disposition END;
 IF disposition->>'kind'='tax_reduction' OR disposition->>'kind'='accepted_stock_return' AND disposition ? 'taxRefund' THEN
  PERFORM procurement.supplier_credit_line_source_key(disposition);
  expected_tax_key:=tax_disposition->>'taxSourceKey';
  SELECT sum(value) INTO original_tax FROM (
   SELECT amount_mills::numeric AS value FROM procurement.vendor_invoice_line_taxes
    WHERE vendor_invoice_line_id=source_line_id AND tax_type_id=(tax_disposition->>'taxTypeId')::integer
     AND expected_tax_key='invoice_line:'||source_line_id::text||':'||(tax_disposition->>'taxTypeId')
   UNION ALL SELECT source.line_total_cents::numeric*100 FROM procurement.inbound_freight_costs charge
    WHERE charge.id=source.freight_cost_id AND charge.tax_type_id=(tax_disposition->>'taxTypeId')::integer
     AND expected_tax_key='shipment_charge:'||charge.id::text||':'||(tax_disposition->>'taxTypeId')
   UNION ALL SELECT amount_mills FROM procurement.current_supplier_invoice_header_shares(source.vendor_invoice_id)
    WHERE line_id=source_line_id AND destination='tax' AND tax_type_id=(tax_disposition->>'taxTypeId')::integer
     AND expected_tax_key='supplier_header:'||entry_key||':'||(tax_disposition->>'taxTypeId')
  ) sources;
  IF original_tax IS NULL OR original_tax<0 OR evidence->'taxCredit'->>'key' IS DISTINCT FROM expected_tax_key
   OR evidence->'taxCredit'->>'taxTypeId' IS DISTINCT FROM tax_disposition->>'taxTypeId'
   OR (evidence->'taxCredit'->>'sourceAmountMills')::numeric IS DISTINCT FROM original_tax
   OR (evidence->'taxCredit'->>'amountMills')::numeric IS DISTINCT FROM amount::numeric*100
  THEN RAISE EXCEPTION 'Tax refund must retain its exact original tax source and amount' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(line.amount_cents),0)*100 INTO refunded FROM procurement.supplier_credit_lines line
   JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
   WHERE line.invoice_line_id=source_line_id AND (line.disposition->>'kind'='tax_reduction' OR line.disposition->>'kind'='accepted_stock_return' AND line.disposition ? 'taxRefund')
    AND coalesce(line.disposition->>'taxSourceKey',line.disposition->'taxRefund'->>'taxSourceKey')=expected_tax_key AND (credit.status='approved' OR credit.id=credit_id);
  IF refunded>original_tax THEN RAISE EXCEPTION 'Cumulative refunds exceed the original tax charge' USING ERRCODE='23514'; END IF;
  IF disposition ? 'receiptAllocation' THEN
   scope:=disposition->'receiptAllocation'; start_piece:=(scope->>'invoiceStartPiece')::numeric; pieces:=(scope->>'pieces')::numeric;
   interval_amount:=floor(original_tax*(start_piece+pieces)/source.qty_invoiced)-floor(original_tax*start_piece/source.qty_invoiced);
   SELECT coalesce(sum(line.amount_cents),0)*100 INTO refunded FROM procurement.supplier_credit_lines line
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    WHERE line.invoice_line_id=source_line_id AND (line.disposition->>'kind'='tax_reduction' OR line.disposition->>'kind'='accepted_stock_return' AND line.disposition ? 'taxRefund')
     AND coalesce(line.disposition->>'taxSourceKey',line.disposition->'taxRefund'->>'taxSourceKey')=expected_tax_key AND line.disposition->'receiptAllocation'=scope
     AND (credit.status='approved' OR credit.id=credit_id);
   IF refunded>interval_amount THEN RAISE EXCEPTION 'Refund exceeds the tax assigned to this receipt' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF disposition->>'kind'='accepted_stock_return' AND EXISTS(SELECT 1 FROM procurement.purchase_order_lines line
   WHERE line.id=source.purchase_order_line_id AND line.receipt_costing_enabled=1) THEN
  scope:=evidence->'acceptedReturnSource'->'invoiceAttribution';
  IF jsonb_typeof(scope) IS DISTINCT FROM 'object' OR jsonb_typeof(scope->'parts') IS DISTINCT FROM 'array'
   OR jsonb_array_length(scope->'parts') NOT BETWEEN 1 AND 10000
   OR (scope->>'invoiceLineId')::integer IS DISTINCT FROM source_line_id
   OR (scope->>'receivingLineId')::integer IS DISTINCT FROM (SELECT (accepted_line.source_snapshot->'sourceProof'->'origin'->>'receivingLineId')::integer
     FROM procurement.supplier_return_lines accepted_line WHERE accepted_line.id=(disposition->>'supplierReturnLineId')::integer)
   OR (scope->>'receiptId')::integer IS DISTINCT FROM (SELECT (accepted_line.source_snapshot->'sourceProof'->'origin'->>'receivingOrderId')::integer
     FROM procurement.supplier_return_lines accepted_line WHERE accepted_line.id=(disposition->>'supplierReturnLineId')::integer)
  THEN RAISE EXCEPTION 'Accepted return requires its exact original receipt invoice assignment' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'parts') part WHERE
    jsonb_typeof(part->'receiptStartPiece') IS DISTINCT FROM 'number' OR jsonb_typeof(part->'invoiceStartPiece') IS DISTINCT FROM 'number'
    OR jsonb_typeof(part->'pieces') IS DISTINCT FROM 'number' OR (part->>'pieces')::numeric<=0 OR (part->>'pieces')::numeric<>trunc((part->>'pieces')::numeric)
    OR (part->>'receivingLineId')::integer IS DISTINCT FROM (scope->>'receivingLineId')::integer
    OR NOT EXISTS(SELECT 1 FROM procurement.receipt_invoice_cost_allocations allocation
      WHERE allocation.invoice_line_id=source_line_id AND allocation.receiving_line_id=(scope->>'receivingLineId')::integer
       AND (part->>'receiptStartPiece')::numeric>=allocation.receipt_start_piece
       AND (part->>'receiptStartPiece')::numeric+(part->>'pieces')::numeric<=allocation.receipt_start_piece+allocation.pieces
       AND (part->>'invoiceStartPiece')::numeric=allocation.invoice_start_piece+(part->>'receiptStartPiece')::numeric-allocation.receipt_start_piece))
   OR EXISTS(SELECT 1 FROM (SELECT (part->>'receiptStartPiece')::numeric AS first,
      lag((part->>'receiptStartPiece')::numeric+(part->>'pieces')::numeric) OVER(ORDER BY (part->>'receiptStartPiece')::numeric) AS previous_end
      FROM jsonb_array_elements(scope->'parts') part) ordered WHERE first<previous_end)
   OR (SELECT sum((part->>'pieces')::numeric) FROM jsonb_array_elements(scope->'parts') part)>
     (evidence->'acceptedReturnSource'->>'quantity')::numeric*(evidence->'acceptedReturnSource'->>'unitsPerVariant')::numeric
  THEN RAISE EXCEPTION 'Returned invoice pieces must belong to their saved receipt assignment' USING ERRCODE='23514'; END IF;
  IF disposition ? 'taxRefund' THEN
   SELECT sum(floor(original_tax*((part->>'invoiceStartPiece')::numeric+(part->>'pieces')::numeric)/source.qty_invoiced)
     -floor(original_tax*(part->>'invoiceStartPiece')::numeric/source.qty_invoiced)) INTO interval_amount FROM jsonb_array_elements(scope->'parts') part;
   SELECT coalesce(sum(line.amount_cents),0)*100 INTO refunded FROM procurement.supplier_credit_lines line
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    WHERE line.invoice_line_id=source_line_id AND line.disposition->'taxRefund'->>'taxSourceKey'=expected_tax_key
     AND line.source_evidence->'acceptedReturnSource'->'invoiceAttribution'->'parts'=scope->'parts'
     AND (credit.status='approved' OR credit.id=credit_id);
   IF refunded>interval_amount THEN RAISE EXCEPTION 'Refund exceeds the original tax on returned invoice pieces' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN;
 END IF;
 IF disposition->>'kind'='quarantine_return' THEN scope:=disposition;
 ELSIF disposition->>'kind'='tax_reduction' AND disposition ? 'quarantineAllocation' THEN scope:=disposition->'quarantineAllocation';
 ELSE RETURN; END IF;
 IF NOT (scope ? 'invoiceStartPiece') THEN RETURN; END IF; -- previously approved legacy return evidence is unchanged
 start_piece:=(scope->>'invoiceStartPiece')::numeric;
 SELECT * INTO returned FROM procurement.receiving_quarantine_dispositions WHERE id=(scope->>'returnDispositionId')::integer FOR SHARE;
 SELECT * INTO observation FROM procurement.receiving_quarantine_observations WHERE id=returned.observation_id FOR SHARE;
 conversion:=observation.units_per_variant_snapshot; pieces:=(scope->>'quantity')::numeric*conversion;
 IF returned.id IS NULL OR returned.kind<>'return' OR returned.acceptance_id IS NOT NULL
  OR observation.purchase_order_line_id IS DISTINCT FROM source.purchase_order_line_id OR conversion IS NULL OR conversion<=0
  OR (scope->>'quantity')::numeric NOT BETWEEN 1 AND returned.observation_qty
  OR (scope->>'quantity')::numeric<>trunc((scope->>'quantity')::numeric) OR start_piece<0 OR start_piece<>trunc(start_piece)
  OR start_piece+pieces>source.qty_invoiced OR scope->>'evidenceReference' IS DISTINCT FROM returned.evidence_reference
  OR evidence->>'returnInvoiceStartPiece' IS DISTINCT FROM (start_piece::bigint)::text
  OR (evidence->'returnSource'->>'dispositionId')::integer IS DISTINCT FROM returned.id
  OR (evidence->'returnSource'->>'receivingLineId')::integer IS DISTINCT FROM observation.receiving_line_id
  OR (evidence->'returnSource'->>'unitsPerVariant')::numeric IS DISTINCT FROM conversion
  OR (evidence->'returnSource'->>'observationQuantity')::numeric IS DISTINCT FROM (scope->>'quantity')::numeric
 THEN RAISE EXCEPTION 'Returned credit must retain exact immutable receiving and billed-piece evidence' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM procurement.receipt_invoice_cost_allocations allocation WHERE invoice_line_id=source_line_id
   AND allocation.invoice_start_piece<start_piece+pieces AND start_piece<allocation.invoice_start_piece+allocation.pieces)
 THEN RAISE EXCEPTION 'Returned billed pieces overlap accepted receipt costs' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM procurement.supplier_credit_lines line JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
   WHERE line.invoice_line_id=source_line_id AND (credit.status='approved' OR credit.id=credit_id)
    AND line.source_evidence->'returnSource' IS NOT NULL AND line.source_evidence ? 'returnInvoiceStartPiece'
    AND (line.source_evidence->>'returnInvoiceStartPiece')::numeric<start_piece+pieces
    AND start_piece<(line.source_evidence->>'returnInvoiceStartPiece')::numeric
      +(line.source_evidence->'returnSource'->>'observationQuantity')::numeric*(line.source_evidence->'returnSource'->>'unitsPerVariant')::numeric
    AND ROW((line.source_evidence->'returnSource'->>'dispositionId')::numeric,(line.source_evidence->>'returnInvoiceStartPiece')::numeric,
      (line.source_evidence->'returnSource'->>'observationQuantity')::numeric)
      IS DISTINCT FROM ROW(returned.id::numeric,start_piece,(scope->>'quantity')::numeric))
 THEN RAISE EXCEPTION 'Distinct returns cannot credit the same billed pieces' USING ERRCODE='23514'; END IF;
 IF disposition->>'kind'='tax_reduction' THEN
  interval_amount:=floor(original_tax*(start_piece+pieces)/source.qty_invoiced)-floor(original_tax*start_piece/source.qty_invoiced);
  SELECT coalesce(sum(line.amount_cents),0)*100 INTO refunded FROM procurement.supplier_credit_lines line
   JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
   WHERE line.invoice_line_id=source_line_id AND (line.disposition->>'kind'='tax_reduction' OR line.disposition->>'kind'='accepted_stock_return' AND line.disposition ? 'taxRefund')
    AND coalesce(line.disposition->>'taxSourceKey',line.disposition->'taxRefund'->>'taxSourceKey')=expected_tax_key AND line.disposition->'quarantineAllocation'=scope
    AND (credit.status='approved' OR credit.id=credit_id);
  IF refunded>interval_amount THEN RAISE EXCEPTION 'Refund exceeds the returned interval tax' USING ERRCODE='23514'; END IF;
 END IF;
END $$;
CREATE FUNCTION procurement.guard_supplier_tax_return_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='supplier_credit_lines' THEN
  PERFORM procurement.assert_supplier_tax_return_credit(NEW.invoice_line_id,NEW.disposition,NEW.source_evidence,NEW.amount_cents,NEW.supplier_credit_id);
 ELSIF NEW.status='approved' AND OLD.status='draft' THEN
  PERFORM procurement.assert_supplier_tax_return_credit(line.invoice_line_id,line.disposition,line.source_evidence,line.amount_cents,NEW.id)
   FROM procurement.supplier_credit_lines line WHERE line.supplier_credit_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_tax_return_credit_line_guard AFTER INSERT ON procurement.supplier_credit_lines
 FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_tax_return_credit();
CREATE TRIGGER supplier_tax_return_credit_approval_guard BEFORE UPDATE ON procurement.supplier_credits
 FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_tax_return_credit();
