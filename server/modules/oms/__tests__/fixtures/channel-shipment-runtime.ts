// Reduced named-schema prerequisites for the actual repository's preparation
// transaction. No provider, inventory writer, SQL interpreter, or query result is
// mocked; this is not a historical migration or physical materializer fixture.
export const channelShipmentRuntimeFixtureSql = `
  CREATE SCHEMA inventory; CREATE SCHEMA oms; CREATE SCHEMA wms;
  CREATE SCHEMA warehouse; CREATE SCHEMA channels;
  CREATE TABLE inventory.availability_runtime_authority
    (singleton_key boolean PRIMARY KEY, authority text, revision bigint, activation_run_id bigint);
  CREATE TABLE channels.channels (id integer PRIMARY KEY, provider text);
  CREATE TABLE oms.oms_orders (id bigint PRIMARY KEY, channel_id integer, external_order_id text);
  CREATE TABLE oms.oms_order_lines (id bigint PRIMARY KEY, order_id bigint, external_line_item_id text,
    paid_quantity integer, authority_fulfillable_quantity integer, product_variant_id integer, sku text);
  CREATE TABLE oms.oms_order_line_authority_events (order_line_id bigint, paid_quantity integer);
  CREATE TABLE wms.orders (id integer PRIMARY KEY, warehouse_status text);
  CREATE TABLE wms.order_items (id integer PRIMARY KEY, order_id integer, oms_order_line_id bigint,
    quantity integer, picked_quantity integer, status text);
  CREATE TABLE inventory.inventory_transactions (id integer PRIMARY KEY, order_item_id integer,
    product_variant_id integer, transaction_type text, from_location_id integer, created_at timestamp);
  CREATE TABLE inventory.inventory_levels (warehouse_location_id integer, product_variant_id integer, variant_qty integer);
  CREATE TABLE warehouse.warehouse_locations (id integer PRIMARY KEY, cycle_count_freeze_id integer);
  CREATE TABLE warehouse.product_locations (id integer PRIMARY KEY, warehouse_location_id integer,
    product_variant_id integer, status text, is_primary integer);
  CREATE TABLE oms.channel_fulfillment_receipts (id integer PRIMARY KEY, processing_status text,
    physical_shipment_id integer, oms_order_id bigint, source_channel_id integer, updated_at timestamp,
    attempt_count integer, lease_token text, lease_expires_at timestamp, last_attempt_at timestamp,
    retry_failure_count integer, next_retry_at timestamp, source_provider text, source_order_id text,
    source_fulfillment_id text, source_event_id text, event_kind text, raw_payload jsonb);
  CREATE TABLE oms.channel_fulfillment_receipt_items (receipt_id integer, source_fulfillment_line_id text,
    channel_order_line_id text, quantity integer, oms_order_line_id bigint, wms_order_item_id integer,
    legacy_wms_shipment_item_id integer, physical_shipment_item_id integer, created_at timestamp,
    UNIQUE(receipt_id, channel_order_line_id));
  CREATE TABLE oms.channel_fulfillment_pushes (id integer PRIMARY KEY, physical_shipment_id integer,
    channel_provider text, oms_order_id bigint, channel_fulfillment_id text, push_status text);
  CREATE TABLE oms.channel_fulfillment_push_items (id integer PRIMARY KEY, channel_fulfillment_push_id integer,
    channel_order_line_id text, quantity_pushed integer, physical_shipment_item_id integer);
  CREATE TABLE wms.physical_shipments (id integer PRIMARY KEY, provider text,
    provider_physical_shipment_id text, status text, tracking_number text);
  CREATE TABLE wms.physical_shipment_items (id integer PRIMARY KEY, physical_shipment_id integer,
    legacy_wms_shipment_item_id integer, fulfillment_plan_line_id integer,
    quantity_shipped integer, shipment_item_purpose text);
  CREATE VIEW wms.effective_physical_shipment_items AS SELECT * FROM wms.physical_shipment_items;
  CREATE TABLE wms.fulfillment_plan_lines (id integer PRIMARY KEY, oms_order_line_id bigint);
  CREATE TABLE wms.outbound_shipments (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id integer, channel_id integer, external_fulfillment_id text, source text, status text,
    carrier text, tracking_number text, tracking_url text, shipped_at timestamp, shipping_engine text,
    engine_order_ref text, engine_shipment_ref text, shopify_fulfillment_id text, requires_review boolean,
    review_reason text, created_at timestamp, updated_at timestamp, shipstation_order_id integer);
  CREATE TABLE wms.outbound_shipment_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_id integer, order_item_id integer, shipment_item_purpose text,
    product_variant_id integer, qty integer, from_location_id integer, tracking_id text, created_at timestamp);
`;

export const channelShipmentRuntimeSeedSql = `
      TRUNCATE inventory.availability_runtime_authority, channels.channels, oms.oms_orders,
        oms.oms_order_lines, oms.oms_order_line_authority_events, wms.orders, wms.order_items,
        inventory.inventory_transactions, inventory.inventory_levels, warehouse.warehouse_locations,
        warehouse.product_locations, oms.channel_fulfillment_receipts, oms.channel_fulfillment_receipt_items,
        wms.outbound_shipment_items, wms.outbound_shipments, wms.physical_shipment_items,
        wms.physical_shipments, wms.fulfillment_plan_lines, oms.channel_fulfillment_push_items,
        oms.channel_fulfillment_pushes RESTART IDENTITY;
      INSERT INTO inventory.availability_runtime_authority VALUES (true,'legacy',1,NULL);
      INSERT INTO channels.channels VALUES (36,'shopify');
      INSERT INTO oms.oms_orders VALUES (11,36,'101');
      INSERT INTO oms.oms_order_lines VALUES (12,11,'line-1',2,2,30,'SKU-30');
      INSERT INTO wms.orders VALUES (40,'shipped');
      INSERT INTO wms.order_items VALUES (50,40,12,2,2,'picked');
      INSERT INTO warehouse.warehouse_locations VALUES (20,NULL),(25,NULL);
      INSERT INTO warehouse.product_locations VALUES (1,25,30,'active',1);
      INSERT INTO inventory.inventory_transactions VALUES (1,50,30,'pick',20,'2026-09-07T19:00:00Z');
      INSERT INTO oms.channel_fulfillment_receipts
        (id,processing_status,attempt_count,lease_token,lease_expires_at,source_provider,source_order_id,
         source_fulfillment_id,event_kind,raw_payload)
        VALUES (91,'processing',1,'lease-1','2026-09-07T20:02:00Z','shopify','101','201','created','{}');
    `;
