-- Repair legacy vendor invoice lines that lost sub-cent unit-cost precision.
--
-- The repair is intentionally conservative. A line qualifies only when:
--   * it is directly linked to a PO line and that PO is linked to the invoice;
--   * the PO has authoritative unit_cost_mills;
--   * the invoice cents mirror equals round_half_up(PO mills / 100); and
--   * the invoice extended total is exactly proportional to either the PO
--     product total or the full PO line total, or independently derives the
--     same mills as the PO.
--
-- Rows without that evidence remain unchanged. Every mutation is captured in
-- an immutable evidence ledger before the source row is updated.

BEGIN;

CREATE TABLE IF NOT EXISTS procurement.vendor_invoice_unit_cost_repairs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_invoice_line_id INTEGER NOT NULL
    REFERENCES procurement.vendor_invoice_lines(id) ON DELETE RESTRICT,
  purchase_order_line_id INTEGER NOT NULL
    REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  repair_key VARCHAR(120) NOT NULL,
  evidence_type VARCHAR(50) NOT NULL,
  previous_unit_cost_cents BIGINT NOT NULL,
  previous_unit_cost_mills BIGINT,
  repaired_unit_cost_cents BIGINT NOT NULL,
  repaired_unit_cost_mills BIGINT NOT NULL,
  invoice_qty INTEGER NOT NULL,
  invoice_line_total_cents BIGINT NOT NULL,
  po_order_qty INTEGER NOT NULL,
  po_unit_cost_cents BIGINT NOT NULL,
  po_unit_cost_mills BIGINT NOT NULL,
  po_total_product_cost_cents BIGINT NOT NULL,
  po_line_total_cents BIGINT,
  previous_match_status VARCHAR(20) NOT NULL,
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vendor_invoice_unit_cost_repairs_identity_uq
    UNIQUE (vendor_invoice_line_id, repair_key),
  CONSTRAINT vendor_invoice_unit_cost_repairs_evidence_chk CHECK (
    evidence_type IN (
      'proportional_po_product_total',
      'proportional_po_line_total',
      'derived_invoice_mills_match'
    )
  ),
  CONSTRAINT vendor_invoice_unit_cost_repairs_previous_mills_chk CHECK (
    previous_unit_cost_mills IS NULL
  ),
  CONSTRAINT vendor_invoice_unit_cost_repairs_money_chk CHECK (
    previous_unit_cost_cents >= 0
    AND repaired_unit_cost_cents >= 0
    AND repaired_unit_cost_mills >= 0
    AND invoice_line_total_cents >= 0
    AND po_unit_cost_cents >= 0
    AND po_unit_cost_mills >= 0
    AND po_total_product_cost_cents >= 0
    AND (po_line_total_cents IS NULL OR po_line_total_cents >= 0)
  ),
  CONSTRAINT vendor_invoice_unit_cost_repairs_quantity_chk CHECK (
    invoice_qty > 0 AND po_order_qty > 0
  ),
  CONSTRAINT vendor_invoice_unit_cost_repairs_cents_mirror_chk CHECK (
    repaired_unit_cost_cents::numeric =
      floor((repaired_unit_cost_mills::numeric + 50) / 100)
  )
);

CREATE INDEX IF NOT EXISTS vendor_invoice_unit_cost_repairs_po_line_idx
  ON procurement.vendor_invoice_unit_cost_repairs(purchase_order_line_id, repaired_at, id);

CREATE OR REPLACE FUNCTION procurement.reject_vendor_invoice_unit_cost_repair_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Vendor invoice unit-cost repair evidence is immutable'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS vendor_invoice_unit_cost_repairs_immutable
  ON procurement.vendor_invoice_unit_cost_repairs;
CREATE TRIGGER vendor_invoice_unit_cost_repairs_immutable
  BEFORE UPDATE OR DELETE ON procurement.vendor_invoice_unit_cost_repairs
  FOR EACH ROW EXECUTE FUNCTION procurement.reject_vendor_invoice_unit_cost_repair_mutation();

WITH repair_candidates AS (
  SELECT
    vil.id AS vendor_invoice_line_id,
    pol.id AS purchase_order_line_id,
    CASE
      WHEN vil.line_total_cents::numeric * pol.order_qty::numeric =
        pol.total_product_cost_cents::numeric * vil.qty_invoiced::numeric
        THEN 'proportional_po_product_total'
      WHEN vil.line_total_cents::numeric * pol.order_qty::numeric =
        pol.line_total_cents::numeric * vil.qty_invoiced::numeric
        THEN 'proportional_po_line_total'
      ELSE 'derived_invoice_mills_match'
    END AS evidence_type,
    vil.unit_cost_cents AS previous_unit_cost_cents,
    vil.unit_cost_mills AS previous_unit_cost_mills,
    floor((pol.unit_cost_mills::numeric + 50) / 100)::bigint
      AS repaired_unit_cost_cents,
    pol.unit_cost_mills AS repaired_unit_cost_mills,
    vil.qty_invoiced AS invoice_qty,
    vil.line_total_cents AS invoice_line_total_cents,
    pol.order_qty AS po_order_qty,
    pol.unit_cost_cents AS po_unit_cost_cents,
    pol.unit_cost_mills AS po_unit_cost_mills,
    pol.total_product_cost_cents AS po_total_product_cost_cents,
    pol.line_total_cents AS po_line_total_cents,
    vil.match_status AS previous_match_status
  FROM procurement.vendor_invoice_lines vil
  JOIN procurement.purchase_order_lines pol
    ON pol.id = vil.purchase_order_line_id
  WHERE vil.unit_cost_mills IS NULL
    AND pol.unit_cost_mills IS NOT NULL
    AND pol.unit_cost_mills >= 0
    AND vil.qty_invoiced > 0
    AND pol.order_qty > 0
    AND vil.unit_cost_cents::numeric =
      floor((pol.unit_cost_mills::numeric + 50) / 100)
    AND EXISTS (
      SELECT 1
      FROM procurement.vendor_invoice_po_links link
      WHERE link.vendor_invoice_id = vil.vendor_invoice_id
        AND link.purchase_order_id = pol.purchase_order_id
    )
    AND (
      vil.line_total_cents::numeric * pol.order_qty::numeric =
        pol.total_product_cost_cents::numeric * vil.qty_invoiced::numeric
      OR vil.line_total_cents::numeric * pol.order_qty::numeric =
        pol.line_total_cents::numeric * vil.qty_invoiced::numeric
      OR floor(
        (vil.line_total_cents::numeric * 100) / vil.qty_invoiced::numeric + 0.5
      ) = pol.unit_cost_mills::numeric
    )
)
INSERT INTO procurement.vendor_invoice_unit_cost_repairs (
  vendor_invoice_line_id,
  purchase_order_line_id,
  repair_key,
  evidence_type,
  previous_unit_cost_cents,
  previous_unit_cost_mills,
  repaired_unit_cost_cents,
  repaired_unit_cost_mills,
  invoice_qty,
  invoice_line_total_cents,
  po_order_qty,
  po_unit_cost_cents,
  po_unit_cost_mills,
  po_total_product_cost_cents,
  po_line_total_cents,
  previous_match_status
)
SELECT
  vendor_invoice_line_id,
  purchase_order_line_id,
  '0620_linked_po_mills_v1',
  evidence_type,
  previous_unit_cost_cents,
  previous_unit_cost_mills,
  repaired_unit_cost_cents,
  repaired_unit_cost_mills,
  invoice_qty,
  invoice_line_total_cents,
  po_order_qty,
  po_unit_cost_cents,
  po_unit_cost_mills,
  po_total_product_cost_cents,
  po_line_total_cents,
  previous_match_status
FROM repair_candidates
ON CONFLICT (vendor_invoice_line_id, repair_key) DO NOTHING;

UPDATE procurement.vendor_invoice_lines vil
SET
  unit_cost_cents = repair.repaired_unit_cost_cents,
  unit_cost_mills = repair.repaired_unit_cost_mills,
  updated_at = NOW()
FROM procurement.vendor_invoice_unit_cost_repairs repair
WHERE repair.repair_key = '0620_linked_po_mills_v1'
  AND repair.vendor_invoice_line_id = vil.id
  AND vil.unit_cost_mills IS NULL;

-- Recompute the same non-voided, PO-line aggregate match projection used by
-- evaluatePurchaseOrderInvoiceMatches(). A repaired line can affect every
-- active invoice contributing quantity to the same PO line.
WITH affected_po_lines AS (
  SELECT DISTINCT purchase_order_line_id
  FROM procurement.vendor_invoice_unit_cost_repairs
  WHERE repair_key = '0620_linked_po_mills_v1'
), active_invoice_lines AS (
  SELECT
    vil.id,
    vil.purchase_order_line_id,
    vil.qty_invoiced,
    COALESCE(vil.unit_cost_mills, vil.unit_cost_cents * 100) AS invoice_unit_cost_mills,
    pol.order_qty,
    COALESCE(pol.received_qty, 0) AS received_qty,
    COALESCE(pol.unit_cost_mills, pol.unit_cost_cents * 100) AS po_unit_cost_mills
  FROM procurement.vendor_invoice_lines vil
  JOIN procurement.vendor_invoices vi
    ON vi.id = vil.vendor_invoice_id
   AND vi.status <> 'voided'
  JOIN procurement.purchase_order_lines pol
    ON pol.id = vil.purchase_order_line_id
  JOIN affected_po_lines affected
    ON affected.purchase_order_line_id = pol.id
), aggregate_quantities AS (
  SELECT
    purchase_order_line_id,
    SUM(qty_invoiced::numeric) AS aggregate_invoiced_qty
  FROM active_invoice_lines
  GROUP BY purchase_order_line_id
), evaluated AS (
  SELECT
    line.id,
    line.received_qty,
    CASE
      WHEN line.invoice_unit_cost_mills <> line.po_unit_cost_mills
        THEN 'price_discrepancy'
      WHEN aggregate.aggregate_invoiced_qty > line.received_qty::numeric
        THEN 'over_billed'
      WHEN aggregate.aggregate_invoiced_qty <> line.order_qty::numeric
        OR aggregate.aggregate_invoiced_qty <> line.received_qty::numeric
        THEN 'qty_discrepancy'
      ELSE 'matched'
    END AS match_status
  FROM active_invoice_lines line
  JOIN aggregate_quantities aggregate
    ON aggregate.purchase_order_line_id = line.purchase_order_line_id
)
UPDATE procurement.vendor_invoice_lines vil
SET
  qty_received = evaluated.received_qty,
  match_status = evaluated.match_status,
  updated_at = NOW()
FROM evaluated
WHERE evaluated.id = vil.id
  AND (
    vil.qty_received IS DISTINCT FROM evaluated.received_qty
    OR vil.match_status IS DISTINCT FROM evaluated.match_status
  );

-- Historical nulls remain available for evidence review. New lines and any
-- financial edit must carry mills and the matching rounded-cent mirror.
CREATE OR REPLACE FUNCTION procurement.require_vendor_invoice_unit_cost_mills()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.unit_cost_mills IS NULL OR NEW.unit_cost_mills < 0 THEN
    RAISE EXCEPTION 'vendor_invoice_lines.unit_cost_mills is required and must be non-negative'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.unit_cost_cents < 0 OR NEW.unit_cost_cents::numeric <>
    floor((NEW.unit_cost_mills::numeric + 50) / 100) THEN
    RAISE EXCEPTION 'vendor invoice unit-cost cents and mills disagree'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_invoice_lines_require_mills_on_insert
  ON procurement.vendor_invoice_lines;
CREATE TRIGGER vendor_invoice_lines_require_mills_on_insert
  BEFORE INSERT ON procurement.vendor_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.require_vendor_invoice_unit_cost_mills();

DROP TRIGGER IF EXISTS vendor_invoice_lines_require_mills_on_financial_update
  ON procurement.vendor_invoice_lines;
CREATE TRIGGER vendor_invoice_lines_require_mills_on_financial_update
  BEFORE UPDATE OF unit_cost_cents, unit_cost_mills, qty_invoiced, line_total_cents
  ON procurement.vendor_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.require_vendor_invoice_unit_cost_mills();

COMMENT ON TABLE procurement.vendor_invoice_unit_cost_repairs IS
  'Immutable before/after evidence for conservative historical invoice unit-cost precision repairs.';
COMMENT ON COLUMN procurement.vendor_invoice_unit_cost_repairs.evidence_type IS
  'Exact relationship proving that copying linked PO mills does not erase a supplier price variance.';

COMMIT;
