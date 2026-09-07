/** Reduced dependencies with the production key types. Tests apply actual0662;
 * this fixture is not proof of replaying all preceding production migrations. */
export const dispatchMigrationFixtureSql = `
CREATE SCHEMA inventory;
CREATE SCHEMA warehouse;
CREATE SCHEMA catalog;
CREATE SCHEMA wms;
CREATE TABLE wms.orders (id integer PRIMARY KEY);
CREATE TABLE wms.order_items (id integer PRIMARY KEY);
CREATE TABLE wms.outbound_shipments (id integer PRIMARY KEY);
CREATE TABLE wms.outbound_shipment_items (id integer PRIMARY KEY);
CREATE TABLE wms.physical_shipments (id bigint PRIMARY KEY);
CREATE TABLE wms.physical_shipment_items (id bigint PRIMARY KEY);
CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY);
CREATE TABLE warehouse.warehouse_locations (id integer PRIMARY KEY);
CREATE TABLE catalog.product_variants (id integer PRIMARY KEY);
CREATE TABLE inventory.inventory_transactions (id integer PRIMARY KEY, transaction_type varchar(30) NOT NULL);
CREATE TABLE inventory.availability_claims (
  id bigint PRIMARY KEY, order_id integer NOT NULL, UNIQUE (id, order_id)
);
CREATE TABLE inventory.availability_claim_lines (
  id bigint PRIMARY KEY, claim_id bigint NOT NULL, UNIQUE (id, claim_id)
);
CREATE TABLE inventory.availability_claim_commands (
  id bigint PRIMARY KEY, claim_id bigint NOT NULL, order_id integer NOT NULL,
  command_type varchar(30) NOT NULL, UNIQUE (id, claim_id),
  CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN ('claim','replace','release','cancel','execute','handoff_build',
      'execute_build','pick','pick_observation','unpick')
  )
);
CREATE TABLE inventory.availability_claim_pick_movements (
  id bigint PRIMARY KEY, claim_id bigint NOT NULL, claim_line_id bigint NOT NULL,
  movement_type varchar(20) NOT NULL, quantity bigint NOT NULL,
  UNIQUE (id, claim_id, claim_line_id)
);
-- Existing0640 append-only prerequisite; the new migration attaches this exact
-- rejection contract only to its own two tables.
CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END;
$$;
`;

export const dispatchMigrationSeedSql = `
TRUNCATE inventory.availability_claim_dispatch_movements,
  inventory.availability_claim_dispatch_receipts,
  inventory.availability_claim_commands, inventory.availability_claim_pick_movements,
  inventory.availability_claim_lines, inventory.availability_claims,
  inventory.inventory_transactions, wms.orders, wms.order_items,
  wms.outbound_shipments, wms.outbound_shipment_items,
  wms.physical_shipments, wms.physical_shipment_items,
  warehouse.warehouses, warehouse.warehouse_locations, catalog.product_variants
  RESTART IDENTITY;
INSERT INTO wms.orders VALUES (1),(2);
INSERT INTO wms.order_items VALUES (10),(20);
INSERT INTO wms.outbound_shipments VALUES (100),(101);
INSERT INTO wms.outbound_shipment_items VALUES (1000),(1001),(1002);
INSERT INTO wms.physical_shipments VALUES (9007199254740993),(9007199254740994);
INSERT INTO wms.physical_shipment_items VALUES (9007199254741003),(9007199254741004);
INSERT INTO warehouse.warehouses VALUES (3);
INSERT INTO warehouse.warehouse_locations VALUES (4);
INSERT INTO catalog.product_variants VALUES (5);
INSERT INTO inventory.inventory_transactions VALUES (6,'ship'),(7,'ship'),(8,'ship');
INSERT INTO inventory.availability_claims VALUES (11,1),(21,2);
INSERT INTO inventory.availability_claim_lines VALUES (12,11),(13,11),(22,21);
INSERT INTO inventory.availability_claim_commands VALUES
  (14,11,1,'dispatch'),(15,11,1,'dispatch'),(16,11,1,'dispatch'),
  (24,21,2,'dispatch'),(30,11,1,'pick'),(31,11,2,'dispatch');
INSERT INTO inventory.availability_claim_pick_movements VALUES
  (40,11,12,'pick',10),(41,11,12,'pick',10),
  (42,11,13,'pick',10),(43,21,22,'pick',10),(44,11,12,'unpick',1);
`;
