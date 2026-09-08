/**
 * Reduced owner tables retain the production lifecycle types and purpose checks:
 * outbound enum/flags from 060, physical status from 115, item purpose defaults
 * from 143/0593 and current purpose constraints from 0608/183. Other shipment
 * columns and lineage triggers are outside this reconstruction query fixture.
 */
export const cutoverShipmentSchemaFixtureSql = `
CREATE TYPE wms.shipment_status AS ENUM (
  'planned', 'queued', 'labeled', 'shipped', 'on_hold', 'voided', 'cancelled', 'returned', 'lost'
);
CREATE TABLE wms.outbound_shipments(
  id integer PRIMARY KEY, order_id integer, status wms.shipment_status NOT NULL DEFAULT 'planned',
  held boolean NOT NULL DEFAULT false, requires_review boolean NOT NULL DEFAULT false
);
CREATE TABLE wms.outbound_shipment_items(
  id integer PRIMARY KEY, shipment_id integer, order_item_id integer, replacement_for_order_item_id integer,
  correction_for_shipment_item_id integer, product_variant_id integer, qty integer,
  shipment_item_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment', from_location_id integer,
  CONSTRAINT outbound_shipment_items_purpose_chk CHECK (
    shipment_item_purpose IN ('customer_fulfillment', 'replacement', 'concession', 'omission_correction', 'unclassified')
  )
);
CREATE TABLE wms.physical_shipments(
  id bigint PRIMARY KEY, status varchar(30) NOT NULL DEFAULT 'shipped',
  CONSTRAINT physical_shipments_status_chk CHECK (status IN ('shipped', 'voided', 'returned', 'review'))
);
CREATE TABLE wms.physical_shipment_items(
  id bigint PRIMARY KEY, physical_shipment_id bigint, wms_order_item_id integer, replacement_for_order_item_id integer,
  legacy_wms_shipment_item_id integer, package_allocation_entry_id bigint, product_variant_id integer, sku text,
  quantity_shipped integer, shipment_item_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment',
  CONSTRAINT physical_shipment_items_purpose_chk CHECK (
    shipment_item_purpose IN ('customer_fulfillment', 'replacement', 'concession', 'omission_correction')
  )
);
CREATE TABLE wms.physical_shipment_item_quantity_adjustments(physical_shipment_item_id bigint PRIMARY KEY,quantity_delta integer);
`;
