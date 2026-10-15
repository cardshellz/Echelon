-- Explicit unpaid shipment-invoice replacement. No historical rows are changed.
ALTER TABLE procurement.vendor_invoices ADD COLUMN IF NOT EXISTS replaces_invoice_id integer;
ALTER TABLE procurement.vendor_invoices
  ADD CONSTRAINT vendor_invoices_replaces_invoice_fk FOREIGN KEY (replaces_invoice_id)
    REFERENCES procurement.vendor_invoices(id) ON DELETE RESTRICT,
  ADD CONSTRAINT vendor_invoices_replacement_not_self_chk CHECK (replaces_invoice_id IS NULL OR replaces_invoice_id <> id);

-- A supplier number has one root forever and at most one current nonvoid bill.
-- Only the explicit successor owner can insert another generation of that number.
DROP INDEX procurement.vendor_invoices_vendor_invoice_idx;
CREATE UNIQUE INDEX vendor_invoices_vendor_invoice_idx
  ON procurement.vendor_invoices(vendor_id,invoice_number) WHERE status <> 'voided';
CREATE UNIQUE INDEX vendor_invoices_root_number_idx
  ON procurement.vendor_invoices(vendor_id,invoice_number) WHERE replaces_invoice_id IS NULL;
CREATE UNIQUE INDEX vendor_invoices_one_successor_idx
  ON procurement.vendor_invoices(replaces_invoice_id) WHERE replaces_invoice_id IS NOT NULL;

CREATE FUNCTION procurement.guard_invoice_replacement_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor procurement.vendor_invoices%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.replaces_invoice_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM procurement.vendor_invoices child WHERE child.replaces_invoice_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'Invoice replacement history cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.replaces_invoice_id IS DISTINCT FROM OLD.replaces_invoice_id THEN
      RAISE EXCEPTION 'Invoice replacement identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.replaces_invoice_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM procurement.vendor_invoices child WHERE child.replaces_invoice_id=OLD.id
    ) THEN
      IF ROW(NEW.vendor_id,NEW.invoice_number,NEW.inbound_shipment_id,NEW.currency)
        IS DISTINCT FROM ROW(OLD.vendor_id,OLD.invoice_number,OLD.inbound_shipment_id,OLD.currency) THEN
        RAISE EXCEPTION 'Invoice replacement document identity is immutable' USING ERRCODE='23514';
      END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM procurement.vendor_invoices child WHERE child.replaces_invoice_id=OLD.id)
      AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'A replaced invoice remains immutable historical evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.replaces_invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO predecessor FROM procurement.vendor_invoices WHERE id=NEW.replaces_invoice_id FOR UPDATE;
  IF NOT FOUND OR predecessor.status <> 'voided' OR predecessor.paid_amount_cents <> 0
    OR predecessor.inbound_shipment_id IS NULL
    OR ROW(NEW.vendor_id,NEW.invoice_number,NEW.inbound_shipment_id,NEW.currency)
      IS DISTINCT FROM ROW(predecessor.vendor_id,predecessor.invoice_number,predecessor.inbound_shipment_id,predecessor.currency)
    OR NEW.status <> 'received' OR NEW.paid_amount_cents <> 0
    OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL
    OR EXISTS(SELECT 1 FROM procurement.ap_payment_allocations WHERE vendor_invoice_id=predecessor.id) THEN
    RAISE EXCEPTION 'Invoice replacement requires a matching voided unpaid shipment invoice without payment history' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vendor_invoice_replacement_lineage_guard
  BEFORE INSERT OR UPDATE OR DELETE ON procurement.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_invoice_replacement_lineage();

CREATE FUNCTION procurement.guard_replaced_invoice_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id integer;
BEGIN
  owner_id := CASE WHEN TG_OP='INSERT' THEN NEW.vendor_invoice_id ELSE OLD.vendor_invoice_id END;
  IF EXISTS(SELECT 1 FROM procurement.vendor_invoices child WHERE child.replaces_invoice_id=owner_id)
    OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM procurement.vendor_invoices child WHERE child.replaces_invoice_id=NEW.vendor_invoice_id)) THEN
    RAISE EXCEPTION 'Replaced invoice evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER replaced_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.vendor_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_replaced_invoice_evidence();
CREATE TRIGGER replaced_invoice_po_links_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.vendor_invoice_po_links
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_replaced_invoice_evidence();
CREATE TRIGGER replaced_invoice_attachments_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement.vendor_invoice_attachments
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_replaced_invoice_evidence();
