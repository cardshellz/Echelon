-- 0565_po_dual_track_status.sql
-- Add physicalStatus + financialStatus columns to purchase_orders for the
-- dual-track lifecycle. The legacy `status` column stays as an aggregate
-- (computed) for back-compat with any caller that hasn't been updated yet.
--
-- Physical track: models the goods-movement lifecycle of the PO.
--   draft → sent → acknowledged → shipped → in_transit → arrived
--        → receiving → received → short_closed (+ cancelled from most states)
--
-- Financial track: models the AP/payment lifecycle.
--   unbilled → invoiced → partially_paid → paid (+ disputed from some states)
--
-- Backfill rules from legacy status:
--   draft / pending_approval / approved  → physical: draft,      financial: unbilled
--   sent                                 → physical: sent,       financial: unbilled
--   acknowledged                         → physical: acknowledged, financial: unbilled
--   partially_received                   → physical: receiving,  financial: <derived>
--   received                             → physical: received,   financial: <derived>
--   closed                               → physical: received,   financial: paid
--   cancelled                            → physical: cancelled,  financial: <derived>
--
-- Financial backfill: derive from vendor_invoices linked via vendor_invoice_po_links.
--   no linked invoices → unbilled
--   linked + balance > 0 + no payments → invoiced
--   linked + balance > 0 + partial payments → partially_paid
--   linked + all balance ≤ 0 → paid
-- Cancelled POs take the same derived financial status.
--
-- Integer money only (Rule #3): all amount columns in BIGINT cents. No floats.

-- ── Step 1: Add new columns ───────────────────────────────────────────────────

ALTER TABLE procurement.purchase_orders
  ADD COLUMN IF NOT EXISTS physical_status  VARCHAR(30) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS financial_status VARCHAR(30) NOT NULL DEFAULT 'unbilled',
  ADD COLUMN IF NOT EXISTS first_shipped_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_arrived_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_invoiced_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_paid_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fully_paid_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoiced_total_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_total_cents     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outstanding_cents    BIGINT NOT NULL DEFAULT 0;

-- ── Step 2: Backfill physical_status from legacy status ──────────────────────

UPDATE procurement.purchase_orders
SET physical_status = CASE
  WHEN status IN ('draft', 'pending_approval', 'approved') THEN 'draft'
  WHEN status = 'sent'               THEN 'sent'
  WHEN status = 'acknowledged'       THEN 'acknowledged'
  WHEN status = 'partially_received' THEN 'receiving'
  WHEN status IN ('received', 'closed') THEN 'received'
  WHEN status = 'cancelled'          THEN 'cancelled'
  ELSE 'draft'
END;

-- ── Step 3: Backfill financial aggregates from vendor_invoices ───────────────
--
-- Sums invoiced_amount_cents and paid_amount_cents from vendor_invoices
-- linked to each PO via vendor_invoice_po_links. Non-voided invoices only.

UPDATE procurement.purchase_orders po
SET
  invoiced_total_cents = COALESCE((
    SELECT SUM(vi.invoiced_amount_cents)
    FROM procurement.vendor_invoice_po_links link
    JOIN procurement.vendor_invoices vi
      ON vi.id = link.vendor_invoice_id
    WHERE link.purchase_order_id = po.id
      AND vi.status <> 'voided'
  ), 0),
  paid_total_cents = COALESCE((
    SELECT SUM(vi.paid_amount_cents)
    FROM procurement.vendor_invoice_po_links link
    JOIN procurement.vendor_invoices vi
      ON vi.id = link.vendor_invoice_id
    WHERE link.purchase_order_id = po.id
      AND vi.status <> 'voided'
  ), 0);

-- Derive outstanding_cents from the aggregates just computed.
UPDATE procurement.purchase_orders
SET outstanding_cents = GREATEST(0, invoiced_total_cents - paid_total_cents);

-- ── Step 4: Backfill first_invoiced_at / first_paid_at from invoice dates ────

UPDATE procurement.purchase_orders po
SET
  first_invoiced_at = (
    SELECT MIN(vi.invoice_date)
    FROM procurement.vendor_invoice_po_links link
    JOIN procurement.vendor_invoices vi
      ON vi.id = link.vendor_invoice_id
    WHERE link.purchase_order_id = po.id
      AND vi.status <> 'voided'
      AND vi.invoice_date IS NOT NULL
  ),
  first_paid_at = (
    SELECT MIN(vi.approved_at)
    FROM procurement.vendor_invoice_po_links link
    JOIN procurement.vendor_invoices vi
      ON vi.id = link.vendor_invoice_id
    WHERE link.purchase_order_id = po.id
      AND vi.status IN ('paid', 'partially_paid')
      AND vi.approved_at IS NOT NULL
  ),
  fully_paid_at = CASE
    WHEN (
      SELECT BOOL_AND(vi.status = 'paid')
      FROM procurement.vendor_invoice_po_links link
      JOIN procurement.vendor_invoices vi
        ON vi.id = link.vendor_invoice_id
      WHERE link.purchase_order_id = po.id
        AND vi.status <> 'voided'
    ) THEN (
      SELECT MAX(vi.approved_at)
      FROM procurement.vendor_invoice_po_links link
      JOIN procurement.vendor_invoices vi
        ON vi.id = link.vendor_invoice_id
      WHERE link.purchase_order_id = po.id
        AND vi.status <> 'voided'
    )
    ELSE NULL
  END;

-- ── Step 5: Backfill financial_status from aggregates ────────────────────────

UPDATE procurement.purchase_orders
SET financial_status = CASE
  -- Closed POs with no invoices are treated as paid (manually reconciled)
  WHEN status = 'closed' AND invoiced_total_cents = 0 THEN 'paid'
  WHEN invoiced_total_cents = 0                       THEN 'unbilled'
  WHEN paid_total_cents >= invoiced_total_cents
    AND invoiced_total_cents > 0                      THEN 'paid'
  WHEN paid_total_cents > 0
    AND paid_total_cents < invoiced_total_cents       THEN 'partially_paid'
  WHEN invoiced_total_cents > 0                       THEN 'invoiced'
  ELSE 'unbilled'
END;

-- ── Step 6: CHECK constraints for enum values ─────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'po_physical_status_chk'
  ) THEN
    ALTER TABLE procurement.purchase_orders
      ADD CONSTRAINT po_physical_status_chk
      CHECK (physical_status IN (
        'draft', 'sent', 'acknowledged', 'shipped', 'in_transit',
        'arrived', 'receiving', 'received', 'cancelled', 'short_closed'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'po_financial_status_chk'
  ) THEN
    ALTER TABLE procurement.purchase_orders
      ADD CONSTRAINT po_financial_status_chk
      CHECK (financial_status IN (
        'unbilled', 'invoiced', 'partially_paid', 'paid', 'disputed'
      ));
  END IF;
END $$;
