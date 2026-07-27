-- 176_use_new_reorder_cockpit_flag.sql
-- Reorder Engine redesign PR 2: feature flag for the new read-only cockpit at
-- /reorder-analysis. Follows the use_new_po_editor pattern (migration 0557):
-- one boolean on inventory.warehouse_settings, default OFF, toggled from the
-- Procurement Settings page. When ON, /reorder-analysis renders the new
-- ReorderEngine page; when OFF (or on any settings-load failure) the legacy
-- PurchasingView renders. /reorder-analysis/legacy always renders the legacy page.
--
-- Safe to re-run: IF NOT EXISTS.

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS use_new_reorder_cockpit BOOLEAN NOT NULL DEFAULT FALSE;
