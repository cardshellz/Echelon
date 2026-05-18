-- 082_po_receipt_reconciliation_exception_kind.sql
-- Allow receiving close to raise a visible PO exception when inventory has
-- posted but PO receipt reconciliation cannot complete.

ALTER TABLE procurement.po_exceptions
  DROP CONSTRAINT IF EXISTS po_exceptions_kind_chk;

ALTER TABLE procurement.po_exceptions
  ADD CONSTRAINT po_exceptions_kind_chk
  CHECK (kind IN (
    'qty_short','qty_over','damaged_on_arrival','wrong_product_received',
    'slow_ack','slow_ship','customs_hold','lost_shipment',
    'match_mismatch','invoice_disputed','credit_memo_pending',
    'payment_failed','overpaid','past_due','vendor_reissued_invoice',
    'receipt_reconciliation_failed'
  ));
