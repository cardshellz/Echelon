-- Migration 087: Make stale auto-draft PO aging thresholds admin-configurable.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS auto_draft_po_review_warning_days INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS auto_draft_po_review_critical_days INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS auto_draft_po_supplier_send_warning_days INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS auto_draft_po_supplier_send_critical_days INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS auto_draft_po_supplier_followup_warning_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_draft_po_supplier_followup_critical_days INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS auto_draft_po_receiving_warning_days INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS auto_draft_po_receiving_critical_days INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_draft_po_ap_closeout_warning_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_draft_po_ap_closeout_critical_days INTEGER NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS auto_draft_po_exception_warning_days INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS auto_draft_po_exception_critical_days INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS auto_draft_po_closeout_warning_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_draft_po_closeout_critical_days INTEGER NOT NULL DEFAULT 14;

UPDATE inventory.warehouse_settings
SET
  auto_draft_po_review_warning_days = COALESCE(auto_draft_po_review_warning_days, 2),
  auto_draft_po_review_critical_days = COALESCE(auto_draft_po_review_critical_days, 5),
  auto_draft_po_supplier_send_warning_days = COALESCE(auto_draft_po_supplier_send_warning_days, 2),
  auto_draft_po_supplier_send_critical_days = COALESCE(auto_draft_po_supplier_send_critical_days, 5),
  auto_draft_po_supplier_followup_warning_days = COALESCE(auto_draft_po_supplier_followup_warning_days, 7),
  auto_draft_po_supplier_followup_critical_days = COALESCE(auto_draft_po_supplier_followup_critical_days, 14),
  auto_draft_po_receiving_warning_days = COALESCE(auto_draft_po_receiving_warning_days, 3),
  auto_draft_po_receiving_critical_days = COALESCE(auto_draft_po_receiving_critical_days, 10),
  auto_draft_po_ap_closeout_warning_days = COALESCE(auto_draft_po_ap_closeout_warning_days, 7),
  auto_draft_po_ap_closeout_critical_days = COALESCE(auto_draft_po_ap_closeout_critical_days, 21),
  auto_draft_po_exception_warning_days = COALESCE(auto_draft_po_exception_warning_days, 1),
  auto_draft_po_exception_critical_days = COALESCE(auto_draft_po_exception_critical_days, 3),
  auto_draft_po_closeout_warning_days = COALESCE(auto_draft_po_closeout_warning_days, 7),
  auto_draft_po_closeout_critical_days = COALESCE(auto_draft_po_closeout_critical_days, 14);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_settings_auto_draft_po_threshold_bounds_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_auto_draft_po_threshold_bounds_chk
      CHECK (
        auto_draft_po_review_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_review_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_supplier_send_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_supplier_send_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_supplier_followup_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_supplier_followup_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_receiving_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_receiving_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_ap_closeout_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_ap_closeout_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_exception_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_exception_critical_days BETWEEN 0 AND 365
        AND auto_draft_po_closeout_warning_days BETWEEN 0 AND 365
        AND auto_draft_po_closeout_critical_days BETWEEN 0 AND 365
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_settings_auto_draft_po_threshold_order_chk'
      AND conrelid = 'inventory.warehouse_settings'::regclass
  ) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_auto_draft_po_threshold_order_chk
      CHECK (
        auto_draft_po_review_warning_days <= auto_draft_po_review_critical_days
        AND auto_draft_po_supplier_send_warning_days <= auto_draft_po_supplier_send_critical_days
        AND auto_draft_po_supplier_followup_warning_days <= auto_draft_po_supplier_followup_critical_days
        AND auto_draft_po_receiving_warning_days <= auto_draft_po_receiving_critical_days
        AND auto_draft_po_ap_closeout_warning_days <= auto_draft_po_ap_closeout_critical_days
        AND auto_draft_po_exception_warning_days <= auto_draft_po_exception_critical_days
        AND auto_draft_po_closeout_warning_days <= auto_draft_po_closeout_critical_days
      );
  END IF;
END $$;
