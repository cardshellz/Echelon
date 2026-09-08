/** Empty reduced tables for read-contract suites; actual234 constraints are proved separately. */
export const operationalShipmentQuantityFixtureSql = `
  CREATE TABLE inventory.operational_shipment_dispatch_receipts(
    id bigint PRIMARY KEY, inventory_transaction_id integer UNIQUE,
    source_shipment_item_id integer, outbound_shipment_id integer, order_id integer,
    product_variant_id integer, warehouse_id integer, warehouse_location_id integer,
    physical_shipment_item_id bigint, replacement_for_order_item_id integer,
    purpose text, quantity integer, total_cost_mills bigint
  );
  CREATE TABLE inventory.operational_shipment_dispatch_lots(
    id bigint PRIMARY KEY, receipt_id bigint, inventory_lot_id integer,
    quantity integer, unit_cost_mills bigint, total_cost_mills bigint
  );
`;
