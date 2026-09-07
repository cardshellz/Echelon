/** Read-contract fixture for the real demand reader; not migration proof. */
export const demandDispatchFixtureSql = `
CREATE SCHEMA inventory; CREATE SCHEMA warehouse; CREATE SCHEMA wms; CREATE SCHEMA catalog;
CREATE TABLE catalog.products (id integer PRIMARY KEY, is_active boolean);
CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer, sku varchar(100),
  is_active boolean, requires_shipping boolean, track_inventory boolean, created_at timestamptz);
CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY, inventory_source_type varchar(20), is_active integer, created_at timestamptz);
CREATE TABLE warehouse.warehouse_locations (id integer PRIMARY KEY, warehouse_id integer);
CREATE TABLE wms.orders (id integer PRIMARY KEY, warehouse_id integer);
CREATE TABLE wms.order_items (id integer PRIMARY KEY, order_id integer, sku varchar(100));
CREATE TABLE wms.outbound_shipments (id integer PRIMARY KEY, order_id integer);
CREATE TABLE wms.outbound_shipment_items (id integer PRIMARY KEY, shipment_id integer, order_item_id integer,
  product_variant_id integer, qty integer, from_location_id integer, shipment_item_purpose varchar(30),
  replacement_for_order_item_id integer, correction_for_shipment_item_id integer);
CREATE TABLE wms.physical_shipments (id bigint PRIMARY KEY, shipment_request_id bigint,
  status varchar(30), ship_date timestamptz, created_at timestamptz);
CREATE TABLE wms.physical_shipment_items (id bigint PRIMARY KEY, physical_shipment_id bigint,
  legacy_wms_shipment_item_id integer, shipment_request_item_id bigint, fulfillment_plan_line_id bigint,
  product_variant_id integer, wms_order_item_id integer, quantity_shipped integer, sku varchar(100), shipment_item_purpose varchar(30));
CREATE TABLE wms.physical_shipment_item_quantity_adjustments (physical_shipment_item_id bigint, quantity_delta integer);
CREATE VIEW wms.effective_physical_shipment_items AS SELECT * FROM wms.physical_shipment_items;
CREATE TABLE wms.shipment_request_items (id bigint PRIMARY KEY, shipment_request_id bigint);
CREATE TABLE wms.shipment_requests (id bigint PRIMARY KEY, warehouse_id integer);
CREATE TABLE wms.fulfillment_plan_lines (id bigint PRIMARY KEY, fulfillment_plan_id bigint, product_variant_id integer);
CREATE TABLE wms.fulfillment_plans (id bigint PRIMARY KEY, wms_order_id integer);
CREATE TABLE inventory.inventory_transactions (id integer PRIMARY KEY, product_variant_id integer,
  order_id integer, order_item_id integer, shipment_id integer, shipment_item_id integer, from_location_id integer,
  transaction_type varchar(30), variant_qty_delta integer, reserved_qty_delta integer,
  source_state varchar(20), target_state varchar(20), reference_type varchar(30), voided_at timestamptz, created_at timestamptz);
CREATE TABLE inventory.availability_claim_dispatch_receipts (id bigint PRIMARY KEY,
  inventory_transaction_id integer UNIQUE, quantity bigint, order_id integer, order_item_id integer,
  warehouse_id integer, warehouse_location_id integer, product_variant_id integer,
  outbound_shipment_id integer, source_shipment_item_id integer,
  physical_shipment_id bigint, physical_shipment_item_id bigint);
CREATE TABLE inventory.build_run_consumptions (id integer PRIMARY KEY, build_run_id integer,
  build_order_component_id integer, inventory_lot_id integer, qty integer);
CREATE TABLE inventory.build_runs (id integer PRIMARY KEY, posted_at timestamptz, created_at timestamptz, status varchar(20));
CREATE TABLE inventory.build_order_components (id integer PRIMARY KEY, component_variant_id integer);
CREATE TABLE inventory.inventory_lots (id integer PRIMARY KEY, warehouse_location_id integer);
CREATE TABLE public.idempotency_keys (key text PRIMARY KEY, request_hash text NOT NULL,
  response_body jsonb, created_at timestamptz NOT NULL, expires_at timestamptz);
CREATE TABLE inventory.transformation_model_versions (idempotency_key text);
CREATE TABLE inventory.location_promise_policy_versions (idempotency_key text);
CREATE TABLE inventory.promise_safety_policy_versions (idempotency_key text);
CREATE TABLE inventory.demand_evidence_snapshots (id integer PRIMARY KEY, evidence jsonb NOT NULL);
`;

export const demandDispatchSeedSql = `
TRUNCATE catalog.products, catalog.product_variants, warehouse.warehouses,
  warehouse.warehouse_locations, wms.orders, wms.order_items, wms.outbound_shipments,
  wms.outbound_shipment_items, wms.physical_shipments, wms.physical_shipment_items,
  wms.physical_shipment_item_quantity_adjustments, inventory.inventory_transactions,
  inventory.availability_claim_dispatch_receipts, public.idempotency_keys, inventory.demand_evidence_snapshots;
INSERT INTO catalog.products VALUES (50,true);
INSERT INTO catalog.product_variants VALUES (5,50,'TEST-P5',true,true,true,'2026-01-01');
INSERT INTO warehouse.warehouses VALUES (3,'internal',1,'2026-01-01');
INSERT INTO warehouse.warehouse_locations VALUES (4,3);
INSERT INTO wms.orders VALUES (1,3);
INSERT INTO wms.order_items VALUES (10,1,'TEST-P5');
INSERT INTO wms.outbound_shipments VALUES (100,1);
INSERT INTO wms.outbound_shipment_items VALUES (1000,100,10,5,5,4,'customer_fulfillment',NULL,NULL);
INSERT INTO inventory.inventory_transactions VALUES (6,5,1,10,100,1000,4,'ship',0,0,'picked','shipped',
  'availability_claim_dispatch',NULL,'2026-08-25T12:00:00Z');
INSERT INTO inventory.availability_claim_dispatch_receipts VALUES
  (9007199254740993,6,5,1,10,3,4,5,100,1000,NULL,NULL);
INSERT INTO inventory.demand_evidence_snapshots VALUES (1,'{"priorSnapshot":"unchanged"}');
`;

export const demandDispatchPhysicalSeedSql = `
INSERT INTO wms.physical_shipments VALUES (9007199254740994,NULL,'shipped','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z');
INSERT INTO wms.physical_shipment_items VALUES (9007199254740995,9007199254740994,1000,NULL,NULL,5,10,5,'TEST-P5','customer_fulfillment');
`;
