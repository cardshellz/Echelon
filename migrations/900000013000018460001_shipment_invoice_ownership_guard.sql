-- Pending allocation: copy these exact bytes into the generated PR migration.
-- No historical records are repaired or validated en masse. Only new ownership
-- changes must satisfy the source contract; ambiguous history stays reviewable.
CREATE OR REPLACE FUNCTION procurement.lock_shipment_billing_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'));
  RETURN NULL;
END $$;

-- Statement triggers take the graph lock before a competing row lock. Application
-- commands use the same order; a row-only advisory trigger would invert it.
DROP TRIGGER IF EXISTS shipment_billing_graph_lock ON procurement.vendor_invoices;
CREATE TRIGGER shipment_billing_graph_lock BEFORE INSERT OR UPDATE OR DELETE
  ON procurement.vendor_invoices FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_shipment_billing_graph();
DROP TRIGGER IF EXISTS shipment_billing_graph_lock ON procurement.vendor_invoice_lines;
CREATE TRIGGER shipment_billing_graph_lock BEFORE INSERT OR UPDATE OR DELETE
  ON procurement.vendor_invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_shipment_billing_graph();
DROP TRIGGER IF EXISTS shipment_billing_graph_lock ON procurement.inbound_freight_costs;
CREATE TRIGGER shipment_billing_graph_lock BEFORE INSERT OR UPDATE OR DELETE
  ON procurement.inbound_freight_costs FOR EACH STATEMENT EXECUTE FUNCTION procurement.lock_shipment_billing_graph();

CREATE OR REPLACE FUNCTION procurement.preserve_shipment_invoice_line_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.freight_cost_id IS NOT NULL AND (TG_OP = 'DELETE' OR
    ROW(NEW.freight_cost_id,NEW.vendor_invoice_id,NEW.purchase_order_line_id,NEW.product_variant_id)
      IS DISTINCT FROM ROW(OLD.freight_cost_id,OLD.vendor_invoice_id,OLD.purchase_order_line_id,OLD.product_variant_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_source_immutable',
      MESSAGE='Shipment invoice source lines are retained evidence; use the explicit void and replacement workflow.';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS shipment_invoice_source_immutable ON procurement.vendor_invoice_lines;
CREATE TRIGGER shipment_invoice_source_immutable BEFORE UPDATE OR DELETE
  ON procurement.vendor_invoice_lines FOR EACH ROW EXECUTE FUNCTION procurement.preserve_shipment_invoice_line_source();

-- TRUNCATE bypasses row triggers and would otherwise erase the evidence that
-- distinguishes a billed charge from an unbilled charge.
CREATE OR REPLACE FUNCTION procurement.reject_shipment_invoice_source_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_source_immutable',
    MESSAGE='Shipment invoice source history cannot be truncated.';
END $$;
DROP TRIGGER IF EXISTS shipment_invoice_source_no_truncate ON procurement.vendor_invoice_lines;
CREATE TRIGGER shipment_invoice_source_no_truncate BEFORE TRUNCATE
  ON procurement.vendor_invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION procurement.reject_shipment_invoice_source_truncate();

-- A historical pointer without line mapping is ambiguous liability evidence,
-- not proof of an unbilled charge. Preserve that association until explicitly
-- binding its existing invoice line; never detach it into a rebilling candidate.
CREATE OR REPLACE FUNCTION procurement.preserve_shipment_invoice_association()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.vendor_invoice_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.vendor_invoice_id IS NULL OR
    (NEW.vendor_invoice_id IS DISTINCT FROM OLD.vendor_invoice_id AND NOT EXISTS (
      SELECT 1 FROM procurement.vendor_invoice_lines WHERE freight_cost_id=OLD.id AND vendor_invoice_id=OLD.vendor_invoice_id))) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_source_immutable',
      MESSAGE='The recorded shipment invoice association is retained billing evidence.';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS shipment_invoice_association_immutable ON procurement.inbound_freight_costs;
CREATE TRIGGER shipment_invoice_association_immutable BEFORE UPDATE OR DELETE
  ON procurement.inbound_freight_costs FOR EACH ROW EXECUTE FUNCTION procurement.preserve_shipment_invoice_association();

CREATE OR REPLACE FUNCTION procurement.assert_shipment_billing_owner(p_cost_id integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  charge procurement.inbound_freight_costs%ROWTYPE;
  document procurement.vendor_invoices%ROWTYPE;
  owner_count integer;
  active_count integer;
  current_id integer;
  current_number text;
  visited integer[] := ARRAY[]::integer[];
BEGIN
  SELECT * INTO charge FROM procurement.inbound_freight_costs WHERE id=p_cost_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(DISTINCT line.vendor_invoice_id),
    count(DISTINCT line.vendor_invoice_id) FILTER (WHERE invoice.status <> 'voided'),
    min(line.vendor_invoice_id) FILTER (WHERE invoice.status <> 'voided')
    INTO owner_count, active_count, current_id
    FROM procurement.vendor_invoice_lines line
    LEFT JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.freight_cost_id=p_cost_id;
  IF owner_count=0 AND charge.vendor_invoice_id IS NULL THEN RETURN; END IF;
  IF owner_count=0 OR active_count>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_owner_consistency',
      MESSAGE='A shipment charge must have exactly one current invoice owner, with explicit voided replacement history.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM procurement.vendor_invoice_lines line
    LEFT JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.freight_cost_id=p_cost_id AND (
      invoice.id IS NULL OR invoice.vendor_id IS DISTINCT FROM charge.vendor_id
      OR invoice.inbound_shipment_id IS DISTINCT FROM charge.inbound_shipment_id
      OR invoice.currency IS DISTINCT FROM charge.currency OR invoice.currency<>'USD'
      OR invoice.status NOT IN ('draft','received','approved','disputed','partially_paid','paid','voided')
      OR line.purchase_order_line_id IS NOT NULL OR line.product_variant_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM procurement.vendor_invoice_lines mixed WHERE mixed.vendor_invoice_id=invoice.id
        AND (mixed.purchase_order_line_id IS NOT NULL OR mixed.product_variant_id IS NOT NULL)))
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_owner_consistency',
      MESSAGE='Shipment invoice supplier, shipment, currency and freight source must agree.';
  END IF;
  current_id := COALESCE(current_id,charge.vendor_invoice_id);
  IF current_id IS NULL OR charge.vendor_invoice_id IS DISTINCT FROM current_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_owner_consistency',
      MESSAGE='Shipment charge invoice pointer must agree with its recorded source lines.';
  END IF;
  SELECT invoice_number INTO current_number FROM procurement.vendor_invoices WHERE id=current_id;
  WHILE current_id IS NOT NULL LOOP
    SELECT * INTO document FROM procurement.vendor_invoices WHERE id=current_id;
    IF NOT FOUND OR current_id=ANY(visited)
      OR document.invoice_number IS DISTINCT FROM current_number
      OR (cardinality(visited)>0 AND document.status<>'voided')
      OR (SELECT count(*) FROM procurement.vendor_invoice_lines WHERE freight_cost_id=p_cost_id AND vendor_invoice_id=current_id)<1 THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_owner_consistency',
        MESSAGE='Shipment invoice history must be one complete, noncompeting replacement chain.';
    END IF;
    visited := array_append(visited,current_id);
    current_id := document.replaces_invoice_id;
  END LOOP;
  IF cardinality(visited)<>owner_count THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='shipment_invoice_owner_consistency',
      MESSAGE='Every historical shipment invoice source must belong to the explicit replacement chain.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION procurement.check_shipment_billing_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_cost integer;
BEGIN
  IF TG_TABLE_NAME='vendor_invoice_lines' THEN
    IF NEW.freight_cost_id IS NOT NULL AND (TG_OP='INSERT' OR
      ROW(NEW.freight_cost_id,NEW.vendor_invoice_id,NEW.purchase_order_line_id,NEW.product_variant_id)
        IS DISTINCT FROM ROW(OLD.freight_cost_id,OLD.vendor_invoice_id,OLD.purchase_order_line_id,OLD.product_variant_id)) THEN
      PERFORM procurement.assert_shipment_billing_owner(NEW.freight_cost_id);
    ELSIF (NEW.purchase_order_line_id IS NOT NULL OR NEW.product_variant_id IS NOT NULL) AND (TG_OP='INSERT' OR
      ROW(NEW.vendor_invoice_id,NEW.purchase_order_line_id,NEW.product_variant_id)
        IS DISTINCT FROM ROW(OLD.vendor_invoice_id,OLD.purchase_order_line_id,OLD.product_variant_id)) THEN
      -- A separate product line on the same header also changes economic source.
      FOR affected_cost IN SELECT DISTINCT freight_cost_id FROM procurement.vendor_invoice_lines
        WHERE vendor_invoice_id=NEW.vendor_invoice_id AND freight_cost_id IS NOT NULL
      LOOP PERFORM procurement.assert_shipment_billing_owner(affected_cost); END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME='inbound_freight_costs' THEN
    IF TG_OP='INSERT' OR ROW(NEW.vendor_invoice_id,NEW.vendor_id,NEW.inbound_shipment_id,NEW.currency)
      IS DISTINCT FROM ROW(OLD.vendor_invoice_id,OLD.vendor_id,OLD.inbound_shipment_id,OLD.currency) THEN
      PERFORM procurement.assert_shipment_billing_owner(NEW.id);
    END IF;
  ELSE
    IF TG_OP='UPDATE' THEN
      -- Voiding cannot add an active owner. Permit this isolated transition even
      -- for preexisting ambiguity; reads continue to show unresolved history.
      IF NEW.status='voided' AND ROW(NEW.vendor_id,NEW.inbound_shipment_id,NEW.currency,NEW.invoice_number,NEW.replaces_invoice_id)
        IS NOT DISTINCT FROM ROW(OLD.vendor_id,OLD.inbound_shipment_id,OLD.currency,OLD.invoice_number,OLD.replaces_invoice_id) THEN RETURN NULL; END IF;
      IF ROW(NEW.status,NEW.vendor_id,NEW.inbound_shipment_id,NEW.currency,NEW.invoice_number,NEW.replaces_invoice_id)
        IS NOT DISTINCT FROM ROW(OLD.status,OLD.vendor_id,OLD.inbound_shipment_id,OLD.currency,OLD.invoice_number,OLD.replaces_invoice_id) THEN RETURN NULL; END IF;
    END IF;
    FOR affected_cost IN SELECT id FROM procurement.inbound_freight_costs WHERE vendor_invoice_id=NEW.id
      UNION SELECT freight_cost_id FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=NEW.id AND freight_cost_id IS NOT NULL
    LOOP PERFORM procurement.assert_shipment_billing_owner(affected_cost); END LOOP;
  END IF;
  RETURN NULL;
END $$;
-- Creation and replacement write header, line and pointer in one transaction;
-- check the committed graph, never an intentionally incomplete intermediate row.
DROP TRIGGER IF EXISTS shipment_billing_owner_check ON procurement.vendor_invoice_lines;
CREATE CONSTRAINT TRIGGER shipment_billing_owner_check AFTER INSERT OR UPDATE ON procurement.vendor_invoice_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION procurement.check_shipment_billing_owner_change();
DROP TRIGGER IF EXISTS shipment_billing_owner_check ON procurement.inbound_freight_costs;
CREATE CONSTRAINT TRIGGER shipment_billing_owner_check AFTER INSERT OR UPDATE ON procurement.inbound_freight_costs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION procurement.check_shipment_billing_owner_change();
DROP TRIGGER IF EXISTS shipment_billing_owner_check ON procurement.vendor_invoices;
CREATE CONSTRAINT TRIGGER shipment_billing_owner_check AFTER INSERT OR UPDATE ON procurement.vendor_invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION procurement.check_shipment_billing_owner_change();
