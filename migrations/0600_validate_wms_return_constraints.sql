-- Validate the WMS return lifecycle and quantity constraints after the
-- production integrity audit reports no invalid return rows.
--
-- Migration 131 installed both constraints as NOT VALID so they protected new
-- writes without blocking deployment on historical data. Validation now
-- extends those existing constraints to every historical return row.
--
-- This migration changes constraint validation state only. It does not update
-- or delete return records.

ALTER TABLE wms.returns
  VALIDATE CONSTRAINT wms_returns_status_chk;

ALTER TABLE wms.return_items
  VALIDATE CONSTRAINT wms_return_items_quantity_chk;
