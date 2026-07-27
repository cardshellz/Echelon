-- Validate the OMS/WMS authority constraints after the production readiness
-- audit reports zero blockers and zero warnings.
--
-- Migration 108 installed these constraints as NOT VALID so they protected new
-- writes while historical drift was repaired. Migration 0589 replaced the
-- obsolete order_item-required check with purpose-aware shipment authority.
-- Validation now extends each active constraint to every historical row.
--
-- Intentionally excluded:
-- - chk_oms_fulfillment_order_id_not_null: legacy WMS orders require a separate
--   historical-lineage decision.
-- - wms_returns_status_chk and wms_return_items_quantity_chk: returns require a
--   dedicated readiness audit before validation.

ALTER TABLE wms.order_items
  VALIDATE CONSTRAINT wms_order_items_oms_order_line_id_fkey;

ALTER TABLE wms.order_items
  VALIDATE CONSTRAINT wms_order_items_quantities_nonnegative_chk;

ALTER TABLE wms.outbound_shipment_items
  VALIDATE CONSTRAINT outbound_shipment_items_purpose_authority_chk;

ALTER TABLE wms.outbound_shipment_items
  VALIDATE CONSTRAINT wms_outbound_shipment_items_order_item_id_fkey;

ALTER TABLE wms.outbound_shipment_items
  VALIDATE CONSTRAINT wms_outbound_shipment_items_qty_positive_chk;
