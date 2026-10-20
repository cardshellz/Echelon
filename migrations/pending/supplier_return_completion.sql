-- Accepted-stock collections preserve gross receipt and invoice history.
-- Initial returned value and later revisions are distinct immutable evidence;
-- no external journal, cash refund or difference disposition is inferred.
CREATE TABLE IF NOT EXISTS procurement.supplier_returns (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 vendor_id integer NOT NULL REFERENCES procurement.vendors(id) ON DELETE RESTRICT,
 supplier_reference varchar(200), return_calendar_date date NOT NULL,
 evidence_reference varchar(1000) NOT NULL CHECK(length(btrim(evidence_reference))>0),
 reason text NOT NULL CHECK(length(btrim(reason))>=3),
 source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 request_fingerprint varchar(64) NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 command_key varchar(200) NOT NULL UNIQUE CHECK(length(btrim(command_key))>0),
 recorded_by text NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_returns_vendor_idx ON procurement.supplier_returns(vendor_id,id);
CREATE TABLE IF NOT EXISTS procurement.supplier_return_lines (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_return_id integer NOT NULL REFERENCES procurement.supplier_returns(id) ON DELETE RESTRICT,
 inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
 inventory_level_id integer NOT NULL REFERENCES inventory.inventory_levels(id) ON DELETE RESTRICT,
 warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
 warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
 product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
 product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
 purchase_order_id integer NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE RESTRICT,
 purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
 receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id) ON DELETE RESTRICT,
 receiving_line_id integer NOT NULL REFERENCES procurement.receiving_lines(id) ON DELETE RESTRICT,
 origin_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0), units_per_variant integer NOT NULL CHECK(units_per_variant>0),
 base_pieces bigint NOT NULL CHECK(base_pieces BETWEEN 1 AND 9007199254740991 AND base_pieces=quantity::bigint*units_per_variant::bigint),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'), UNIQUE(supplier_return_id,inventory_lot_id)
);
CREATE INDEX IF NOT EXISTS supplier_return_lines_po_idx ON procurement.supplier_return_lines(purchase_order_id,id);
CREATE INDEX IF NOT EXISTS supplier_return_lines_receipt_idx ON procurement.supplier_return_lines(receiving_order_id,id);
CREATE TABLE IF NOT EXISTS inventory.supplier_return_allocations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_return_line_id integer NOT NULL UNIQUE REFERENCES procurement.supplier_return_lines(id) ON DELETE RESTRICT,
 inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
 inventory_transaction_id integer NOT NULL UNIQUE REFERENCES inventory.inventory_transactions(id) ON DELETE RESTRICT,
 allocation_id bigint NOT NULL UNIQUE REFERENCES inventory.lot_cost_quantity_allocations(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0), source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
 recorded_by text NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_return_allocations_lot_idx ON inventory.supplier_return_allocations(inventory_lot_id,id);
CREATE TABLE IF NOT EXISTS inventory.supplier_return_cost_entries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 return_allocation_id bigint NOT NULL REFERENCES inventory.supplier_return_allocations(id) ON DELETE RESTRICT,
 component varchar(20) NOT NULL CHECK(component IN ('product','packaging','landed')),
 previous_mills bigint NOT NULL CHECK(previous_mills BETWEEN 0 AND 9007199254740991),
 next_mills bigint NOT NULL CHECK(next_mills BETWEEN 0 AND 9007199254740991),
 delta_mills bigint NOT NULL CHECK(delta_mills BETWEEN -9007199254740991 AND 9007199254740991 AND previous_mills+delta_mills=next_mills),
 posting_key varchar(500) NOT NULL CHECK(length(btrim(posting_key))>0), reason text NOT NULL CHECK(length(btrim(reason))>0),
 source_revision_id bigint REFERENCES procurement.cost_source_revisions(id) ON DELETE RESTRICT,
 application_id bigint REFERENCES inventory.cost_applications(id) ON DELETE RESTRICT,
 recorded_by text NOT NULL CHECK(length(btrim(recorded_by)) BETWEEN 1 AND 500), recorded_at timestamptz NOT NULL,
 UNIQUE(return_allocation_id,posting_key,component)
);
CREATE INDEX IF NOT EXISTS supplier_return_cost_entries_current_idx ON inventory.supplier_return_cost_entries(return_allocation_id,component,id);
CREATE TABLE IF NOT EXISTS procurement.supplier_return_credit_entitlements (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_return_line_id integer NOT NULL REFERENCES procurement.supplier_return_lines(id) ON DELETE RESTRICT,
 return_allocation_id bigint NOT NULL REFERENCES inventory.supplier_return_allocations(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0), intervals jsonb NOT NULL CHECK(jsonb_typeof(intervals)='array'),
 source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
 recorded_by text NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_return_entitlements_line_idx ON procurement.supplier_return_credit_entitlements(supplier_return_line_id,id);
CREATE TABLE IF NOT EXISTS procurement.supplier_return_credit_links (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_credit_line_id integer NOT NULL UNIQUE REFERENCES procurement.supplier_credit_lines(id) ON DELETE RESTRICT,
 entitlement_id integer NOT NULL REFERENCES procurement.supplier_return_credit_entitlements(id) ON DELETE RESTRICT,
 component varchar(20) NOT NULL CHECK(component IN ('product','packaging','landed','unassigned')),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
 recorded_by text NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_return_credit_links_entitlement_idx ON procurement.supplier_return_credit_links(entitlement_id,id);
CREATE TABLE IF NOT EXISTS procurement.supplier_return_reporting_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 supplier_return_id integer NOT NULL UNIQUE REFERENCES procurement.supplier_returns(id) ON DELETE RESTRICT,
 contract_version integer NOT NULL CHECK(contract_version=1), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory.supplier_return_followups (
 supplier_return_id integer NOT NULL REFERENCES procurement.supplier_returns(id) ON DELETE RESTRICT,
 product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL, completed_at timestamptz, PRIMARY KEY(supplier_return_id,product_variant_id)
);
CREATE TABLE IF NOT EXISTS procurement.supplier_return_credit_reviews (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entitlement_id integer NOT NULL REFERENCES procurement.supplier_return_credit_entitlements(id) ON DELETE RESTRICT,
 source_fingerprint varchar(64) NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 expected_version varchar(64) NOT NULL CHECK(expected_version ~ '^[a-f0-9]{64}$'),
 disposition varchar(30) NOT NULL CHECK(disposition IN ('attribution_only','awaiting_supplier_note','supplier_declined')),
 assignments jsonb NOT NULL CHECK(jsonb_typeof(assignments)='array'),
 source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
 evidence_reference varchar(1000) NOT NULL CHECK(length(btrim(evidence_reference))>0), reason text NOT NULL CHECK(length(btrim(reason))>=3),
 recorded_by text NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT, recorded_at timestamptz NOT NULL,
 UNIQUE(entitlement_id,expected_version)
);
ALTER TABLE inventory.quantity_commands DROP CONSTRAINT IF EXISTS quantity_commands_kind_check;
ALTER TABLE inventory.quantity_commands ADD CONSTRAINT quantity_commands_kind_check CHECK(kind IN
 ('opening','receive','receipt_reversal','reserve','release','pick','unpick','pack','unpack','ship','transfer','transform','return','adjust','supplier_return'));

CREATE OR REPLACE FUNCTION procurement.reject_supplier_return_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Supplier return custody, value and credit linkage history is immutable' USING ERRCODE='23514';
END; $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement.supplier_returns','procurement.supplier_return_lines',
  'inventory.supplier_return_allocations','inventory.supplier_return_cost_entries',
  'procurement.supplier_return_credit_entitlements','procurement.supplier_return_credit_links','procurement.supplier_return_reporting_events',
  'procurement.supplier_return_credit_reviews'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS supplier_return_history_immutable ON %s',relation);
  EXECUTE format('CREATE TRIGGER supplier_return_history_immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION procurement.reject_supplier_return_history_mutation()',relation);
  EXECUTE format('DROP TRIGGER IF EXISTS supplier_return_history_no_truncate ON %s',relation);
  EXECUTE format('CREATE TRIGGER supplier_return_history_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_supplier_return_history_mutation()',relation);
  EXECUTE format('DROP TRIGGER IF EXISTS supplier_return_graph_lock ON %s',relation);
  EXECUTE format('CREATE TRIGGER supplier_return_graph_lock BEFORE INSERT ON %s FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_ap_payment_graph()',relation);
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION procurement.guard_supplier_return_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header procurement.supplier_returns%ROWTYPE; snapshot jsonb; origin jsonb;
BEGIN
 SELECT * INTO STRICT header FROM procurement.supplier_returns WHERE id=NEW.supplier_return_id;
 snapshot:=NEW.source_snapshot; origin:=snapshot->'sourceProof'->'origin';
 IF snapshot->'inventoryLotId' IS DISTINCT FROM to_jsonb(NEW.inventory_lot_id)
 OR snapshot->'inventoryLevelId' IS DISTINCT FROM to_jsonb(NEW.inventory_level_id)
 OR snapshot->'warehouseLocationId' IS DISTINCT FROM to_jsonb(NEW.warehouse_location_id)
 OR snapshot->'warehouseId' IS DISTINCT FROM to_jsonb(NEW.warehouse_id)
 OR snapshot->'productId' IS DISTINCT FROM to_jsonb(NEW.product_id)
 OR snapshot->'productVariantId' IS DISTINCT FROM to_jsonb(NEW.product_variant_id)
 OR snapshot->'quantity' IS DISTINCT FROM to_jsonb(NEW.quantity)
 OR snapshot->'unitsPerVariant' IS DISTINCT FROM to_jsonb(NEW.units_per_variant)
 OR snapshot->'basePieces' IS DISTINCT FROM to_jsonb(NEW.base_pieces)
 OR origin->'vendorId' IS DISTINCT FROM to_jsonb(header.vendor_id)
 OR origin->'inventoryLotId' IS DISTINCT FROM to_jsonb(NEW.origin_lot_id)
 OR origin->'purchaseOrderId' IS DISTINCT FROM to_jsonb(NEW.purchase_order_id)
 OR origin->'purchaseOrderLineId' IS DISTINCT FROM to_jsonb(NEW.purchase_order_line_id)
 OR origin->'receivingOrderId' IS DISTINCT FROM to_jsonb(NEW.receiving_order_id)
 OR origin->'receivingLineId' IS DISTINCT FROM to_jsonb(NEW.receiving_line_id)
 OR NOT EXISTS(SELECT 1 FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
   WHERE line.id=NEW.purchase_order_line_id AND po.id=NEW.purchase_order_id AND po.vendor_id=header.vendor_id AND line.product_id=NEW.product_id)
 THEN RAISE EXCEPTION 'Supplier return line does not match its frozen supplier and stock source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_line_guard ON procurement.supplier_return_lines;
CREATE TRIGGER supplier_return_line_guard BEFORE INSERT ON procurement.supplier_return_lines FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_return_line();

CREATE OR REPLACE FUNCTION inventory.guard_supplier_return_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line procurement.supplier_return_lines%ROWTYPE; header procurement.supplier_returns%ROWTYPE;
 allocation inventory.lot_cost_quantity_allocations%ROWTYPE; movement inventory.inventory_transactions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT line FROM procurement.supplier_return_lines WHERE id=NEW.supplier_return_line_id;
 SELECT * INTO STRICT header FROM procurement.supplier_returns WHERE id=line.supplier_return_id;
 SELECT * INTO STRICT allocation FROM inventory.lot_cost_quantity_allocations WHERE id=NEW.allocation_id;
 SELECT * INTO STRICT movement FROM inventory.inventory_transactions WHERE id=NEW.inventory_transaction_id;
 IF NEW.inventory_lot_id<>line.inventory_lot_id OR NEW.quantity<>line.quantity OR allocation.inventory_lot_id<>line.inventory_lot_id
 OR allocation.quantity<>line.quantity OR allocation.direction<>1 OR allocation.intervals IS DISTINCT FROM line.source_snapshot->'intervals'
 OR NEW.recorded_by<>header.recorded_by OR NEW.recorded_at<>header.recorded_at
 OR NEW.source_evidence->'contractVersion' IS DISTINCT FROM '1'::jsonb
 OR NEW.source_evidence->'previewLine' IS DISTINCT FROM line.source_snapshot
 OR NEW.source_evidence->>'sourceFingerprint' IS DISTINCT FROM header.source_fingerprint
 OR NEW.source_evidence->>'requestFingerprint' IS DISTINCT FROM header.request_fingerprint
 OR coalesce(NEW.source_evidence->>'quantityAuthority','') NOT IN ('pre_opening','ledger')
 OR movement.inventory_lot_id IS DISTINCT FROM line.inventory_lot_id OR movement.product_variant_id IS DISTINCT FROM line.product_variant_id
 OR movement.from_location_id IS DISTINCT FROM line.warehouse_location_id OR movement.to_location_id IS NOT NULL
 OR movement.variant_qty_delta<>-line.quantity OR movement.units_per_variant_snapshot IS DISTINCT FROM line.units_per_variant
 OR movement.transaction_type<>'supplier_return' OR movement.reference_type IS DISTINCT FROM 'supplier_return'
 OR movement.reference_id IS DISTINCT FROM line.id::text
 THEN RAISE EXCEPTION 'Supplier return allocation must match its exact outgoing stock transaction and cost intervals' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_allocation_guard ON inventory.supplier_return_allocations;
CREATE TRIGGER supplier_return_allocation_guard BEFORE INSERT ON inventory.supplier_return_allocations FOR EACH ROW EXECUTE FUNCTION inventory.guard_supplier_return_allocation();

CREATE OR REPLACE FUNCTION inventory.guard_supplier_return_cost_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE returned inventory.supplier_return_allocations%ROWTYPE; lot inventory.inventory_lots%ROWTYPE;
 intervals jsonb; prior bigint; total numeric; expected numeric; first_entry boolean;
BEGIN
 SELECT * INTO STRICT returned FROM inventory.supplier_return_allocations WHERE id=NEW.return_allocation_id FOR UPDATE;
 SELECT * INTO STRICT lot FROM inventory.inventory_lots WHERE id=returned.inventory_lot_id;
 SELECT allocation.intervals INTO STRICT intervals FROM inventory.lot_cost_quantity_allocations allocation WHERE id=returned.allocation_id;
 SELECT next_mills INTO prior FROM inventory.supplier_return_cost_entries
  WHERE return_allocation_id=NEW.return_allocation_id AND component=NEW.component ORDER BY id DESC LIMIT 1;
 first_entry:=NOT FOUND;
 total:=CASE NEW.component WHEN 'product' THEN lot.product_total_cost_mills WHEN 'packaging' THEN lot.packaging_total_cost_mills WHEN 'landed' THEN lot.landed_total_cost_mills END;
 IF lot.cost_basis_qty IS NULL OR lot.cost_basis_qty<=0 OR total IS NULL OR total<0 OR total>9007199254740991
 THEN RAISE EXCEPTION 'Returned value requires exact current lot component evidence' USING ERRCODE='23514'; END IF;
 SELECT sum(floor(total*((part->>'start')::numeric+(part->>'quantity')::numeric)/lot.cost_basis_qty)
  -floor(total*(part->>'start')::numeric/lot.cost_basis_qty)) INTO expected FROM jsonb_array_elements(intervals) part;
 IF NEW.previous_mills IS DISTINCT FROM coalesce(prior,0) OR NEW.next_mills IS DISTINCT FROM expected
 OR (first_entry AND (NEW.recorded_by<>returned.recorded_by OR NEW.recorded_at<>returned.recorded_at OR NEW.source_revision_id IS NOT NULL OR NEW.application_id IS NOT NULL))
 THEN RAISE EXCEPTION 'Returned value must continue its immutable exact allocation history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_cost_entry_guard ON inventory.supplier_return_cost_entries;
CREATE TRIGGER supplier_return_cost_entry_guard BEFORE INSERT ON inventory.supplier_return_cost_entries FOR EACH ROW EXECUTE FUNCTION inventory.guard_supplier_return_cost_entry();

CREATE OR REPLACE FUNCTION procurement.guard_supplier_return_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE returned inventory.supplier_return_allocations%ROWTYPE; allowed jsonb; part jsonb; claimed numeric; previous_end numeric:=-1;
BEGIN
 SELECT * INTO STRICT returned FROM inventory.supplier_return_allocations WHERE id=NEW.return_allocation_id FOR UPDATE;
 SELECT intervals INTO STRICT allowed FROM inventory.lot_cost_quantity_allocations WHERE id=returned.allocation_id;
 IF returned.supplier_return_line_id<>NEW.supplier_return_line_id OR jsonb_array_length(NEW.intervals)=0
 THEN RAISE EXCEPTION 'Return entitlement requires its exact physical allocation' USING ERRCODE='23514'; END IF;
 claimed:=0;
 FOR part IN SELECT value FROM jsonb_array_elements(NEW.intervals) ORDER BY (value->>'start')::numeric LOOP
  IF jsonb_typeof(part->'start') IS DISTINCT FROM 'number' OR jsonb_typeof(part->'quantity') IS DISTINCT FROM 'number'
   OR (part->>'start')::numeric<0 OR (part->>'start')::numeric<>trunc((part->>'start')::numeric)
   OR (part->>'quantity')::numeric<=0 OR (part->>'quantity')::numeric<>trunc((part->>'quantity')::numeric)
   OR (part->>'start')::numeric<previous_end
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(allowed) source
    WHERE (part->>'start')::numeric>=(source->>'start')::numeric
     AND (part->>'start')::numeric+(part->>'quantity')::numeric<=(source->>'start')::numeric+(source->>'quantity')::numeric)
   OR EXISTS(SELECT 1 FROM procurement.supplier_return_credit_entitlements entitlement,
    LATERAL jsonb_array_elements(entitlement.intervals) occupied WHERE entitlement.return_allocation_id=NEW.return_allocation_id
     AND (part->>'start')::numeric<(occupied->>'start')::numeric+(occupied->>'quantity')::numeric
     AND (occupied->>'start')::numeric<(part->>'start')::numeric+(part->>'quantity')::numeric)
  THEN RAISE EXCEPTION 'Return entitlement overlaps or exceeds immutable returned units' USING ERRCODE='23514'; END IF;
  previous_end:=(part->>'start')::numeric+(part->>'quantity')::numeric;
  claimed:=claimed+(part->>'quantity')::numeric;
 END LOOP;
 IF claimed<>NEW.quantity THEN RAISE EXCEPTION 'Return entitlement quantity does not equal its intervals' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_entitlement_guard ON procurement.supplier_return_credit_entitlements;
CREATE TRIGGER supplier_return_entitlement_guard BEFORE INSERT ON procurement.supplier_return_credit_entitlements FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_return_entitlement();

CREATE OR REPLACE FUNCTION procurement.guard_supplier_return_credit_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit_line procurement.supplier_credit_lines%ROWTYPE; credit procurement.supplier_credits%ROWTYPE;
 entitlement procurement.supplier_return_credit_entitlements%ROWTYPE; vendor integer;
BEGIN
 SELECT * INTO STRICT credit_line FROM procurement.supplier_credit_lines WHERE id=NEW.supplier_credit_line_id;
 SELECT * INTO STRICT credit FROM procurement.supplier_credits WHERE id=credit_line.supplier_credit_id;
 SELECT * INTO STRICT entitlement FROM procurement.supplier_return_credit_entitlements WHERE id=NEW.entitlement_id;
 SELECT header.vendor_id INTO STRICT vendor FROM procurement.supplier_return_lines line JOIN procurement.supplier_returns header ON header.id=line.supplier_return_id
  WHERE line.id=entitlement.supplier_return_line_id;
 IF credit.status<>'approved' OR credit.vendor_id<>vendor OR credit.currency<>'USD' OR NEW.amount_cents<>credit_line.amount_cents
 OR credit_line.disposition->>'kind' IS DISTINCT FROM 'accepted_stock_return'
 OR credit_line.disposition->'supplierReturnLineId' IS DISTINCT FROM to_jsonb(entitlement.supplier_return_line_id)
 OR credit_line.disposition->'quantity' IS DISTINCT FROM to_jsonb(entitlement.quantity)
 OR credit_line.disposition->>'component' IS DISTINCT FROM NEW.component
 OR credit_line.source_evidence->'acceptedReturnSource'->'intervals' IS DISTINCT FROM entitlement.intervals
 THEN RAISE EXCEPTION 'Supplier credit link does not match its reviewed returned quantity and amount' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_credit_link_guard ON procurement.supplier_return_credit_links;
CREATE TRIGGER supplier_return_credit_link_guard BEFORE INSERT ON procurement.supplier_return_credit_links FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_return_credit_link();

CREATE OR REPLACE FUNCTION procurement.guard_supplier_return_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header procurement.supplier_returns%ROWTYPE;
BEGIN
 SELECT * INTO STRICT header FROM procurement.supplier_returns WHERE id=NEW.supplier_return_id;
 IF NEW.payload->>'eventType' IS DISTINCT FROM 'inventory.supplier_return_recorded'
 OR NEW.payload->'returnId' IS DISTINCT FROM to_jsonb(header.id)
 OR NEW.payload->'vendorId' IS DISTINCT FROM to_jsonb(header.vendor_id)
 OR NEW.payload->>'actorId' IS DISTINCT FROM header.recorded_by
 OR NEW.recorded_at<>header.recorded_at
 THEN RAISE EXCEPTION 'Supplier return report must retain its physical collection identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_report_guard ON procurement.supplier_return_reporting_events;
CREATE TRIGGER supplier_return_report_guard BEFORE INSERT ON procurement.supplier_return_reporting_events FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_return_report();

CREATE OR REPLACE FUNCTION procurement.assert_supplier_return_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM procurement.supplier_return_lines WHERE supplier_return_id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM procurement.supplier_return_reporting_events WHERE supplier_return_id=NEW.id)
 OR EXISTS(SELECT 1 FROM procurement.supplier_return_lines line WHERE line.supplier_return_id=NEW.id
   AND NOT EXISTS(SELECT 1 FROM inventory.supplier_return_followups followup
     WHERE followup.supplier_return_id=NEW.id AND followup.product_variant_id=line.product_variant_id))
 OR EXISTS(SELECT 1 FROM procurement.supplier_return_lines line
  LEFT JOIN inventory.supplier_return_allocations allocation ON allocation.supplier_return_line_id=line.id
  WHERE line.supplier_return_id=NEW.id AND (allocation.id IS NULL OR
   (SELECT count(DISTINCT component) FROM inventory.supplier_return_cost_entries entry WHERE entry.return_allocation_id=allocation.id)<>3))
 THEN RAISE EXCEPTION 'A recorded supplier collection requires complete stock, component-value and reporting evidence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_complete ON procurement.supplier_returns;
CREATE CONSTRAINT TRIGGER supplier_return_complete AFTER INSERT ON procurement.supplier_returns DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION procurement.assert_supplier_return_complete();

-- Reviewed attribution cannot edit a note or create a new monetary destination.
CREATE OR REPLACE FUNCTION procurement.guard_supplier_return_credit_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; link procurement.supplier_return_credit_links%ROWTYPE; status text; seen bigint[]:='{}';
 product numeric; packaging numeric; landed numeric;
BEGIN
 PERFORM id FROM procurement.supplier_return_credit_entitlements WHERE id=NEW.entitlement_id FOR UPDATE;
 IF NEW.source_evidence->'entitlementId' IS DISTINCT FROM to_jsonb(NEW.entitlement_id)
 THEN RAISE EXCEPTION 'Return review source must identify its immutable entitlement' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.assignments) LOOP
  IF jsonb_typeof(item->'creditLinkId') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'productCents') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'packagingCents') IS DISTINCT FROM 'number'
   OR jsonb_typeof(item->'landedCents') IS DISTINCT FROM 'number'
  THEN RAISE EXCEPTION 'Return credit attribution must use exact integers' USING ERRCODE='23514'; END IF;
  product:=(item->>'productCents')::numeric; packaging:=(item->>'packagingCents')::numeric; landed:=(item->>'landedCents')::numeric;
  IF product<0 OR packaging<0 OR landed<>0 OR product<>trunc(product) OR packaging<>trunc(packaging)
   OR product>9007199254740991 OR packaging>9007199254740991
   OR (item->>'creditLinkId')::numeric<>trunc((item->>'creditLinkId')::numeric)
   OR (item->>'creditLinkId')::bigint=ANY(seen)
  THEN RAISE EXCEPTION 'Return credit attribution must be unique supported goods amounts' USING ERRCODE='23514'; END IF;
  SELECT * INTO link FROM procurement.supplier_return_credit_links WHERE id=(item->>'creditLinkId')::bigint;
  SELECT credit.status INTO status FROM procurement.supplier_credit_lines line JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
   WHERE line.id=link.supplier_credit_line_id;
  IF link.id IS NULL OR link.entitlement_id<>NEW.entitlement_id OR link.component<>'unassigned' OR status IS DISTINCT FROM 'approved'
   OR product+packaging<>link.amount_cents
  THEN RAISE EXCEPTION 'Return attribution must conserve one current unassigned supplier credit' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,link.id::bigint);
 END LOOP;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_credit_review_guard ON procurement.supplier_return_credit_reviews;
CREATE TRIGGER supplier_return_credit_review_guard BEFORE INSERT ON procurement.supplier_return_credit_reviews
 FOR EACH ROW EXECUTE FUNCTION procurement.guard_supplier_return_credit_review();

CREATE OR REPLACE FUNCTION inventory.protect_supplier_return_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM inventory.supplier_return_allocations WHERE inventory_transaction_id=OLD.id)
 THEN RAISE EXCEPTION 'Recorded supplier return stock transaction is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS supplier_return_transaction_guard ON inventory.inventory_transactions;
CREATE TRIGGER supplier_return_transaction_guard BEFORE UPDATE OR DELETE ON inventory.inventory_transactions
 FOR EACH ROW EXECUTE FUNCTION inventory.protect_supplier_return_transaction();

-- Preserve every existing credit lifecycle/conservation guard while admitting
-- the independent accepted-stock return source discriminator.
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
       OR NEW.source_key IS DISTINCT FROM (CASE WHEN NEW.disposition->>'kind'='price_reduction' THEN 'price_reduction:'||(NEW.disposition->>'component') WHEN NEW.disposition->>'kind'='quarantine_return' THEN 'quarantine_return:'||(NEW.disposition->>'returnDispositionId') WHEN NEW.disposition->>'kind'='accepted_stock_return' THEN 'accepted_stock_return:'||(NEW.disposition->>'supplierReturnLineId')||':'||coalesce(NEW.disposition->>'entitlementId','new')||':'||(NEW.disposition->>'component') END) THEN
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
