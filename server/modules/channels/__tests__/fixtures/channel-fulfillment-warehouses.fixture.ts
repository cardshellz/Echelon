/** Reduced named-schema read contract; no production data or migrations run here. */
export const canonicalWarehouseSourceTablesSql = `
  ALTER TABLE warehouse.warehouses ADD COLUMN IF NOT EXISTS is_active integer NOT NULL DEFAULT 1;
  ALTER TABLE warehouse.warehouses ADD COLUMN IF NOT EXISTS warehouse_type text NOT NULL DEFAULT 'operations';
  CREATE TABLE channels.walmart_connections(channel_id integer PRIMARY KEY,warehouse_id integer NOT NULL);
  CREATE TABLE warehouse.fulfillment_nodes(id bigint PRIMARY KEY,warehouse_id integer,lifecycle_status text,fulfillment_authority text DEFAULT 'echelon');
  CREATE TABLE inventory.inventory_publication_targets(id bigint PRIMARY KEY,channel_id integer,enabled boolean DEFAULT false,fulfillment_node_id bigint,publication_authority text DEFAULT 'echelon');
  CREATE TABLE inventory.publication_source_binding_versions(id bigint PRIMARY KEY,publication_target_id bigint,lifecycle_status text);
  CREATE TABLE inventory.publication_source_binding_heads(publication_target_id bigint PRIMARY KEY,active_binding_id bigint,draft_binding_id bigint);
  CREATE TABLE inventory.publication_source_binding_members(binding_id bigint,publication_target_id bigint,fulfillment_node_id bigint);
`;

export const channelWarehouseSourceFixtureSql = `
  CREATE SCHEMA channels; CREATE SCHEMA inventory; CREATE SCHEMA warehouse;
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
  CREATE TABLE channels.channel_warehouse_assignments(channel_id integer,warehouse_id integer,enabled boolean);
  CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY,name text);
  CREATE TABLE inventory.availability_runtime_authority(singleton_key boolean PRIMARY KEY,authority text,revision bigint,activation_run_id bigint);
  INSERT INTO inventory.availability_runtime_authority VALUES(true,'canonical',2,46);
  ${canonicalWarehouseSourceTablesSql}
  INSERT INTO channels.channels VALUES(36,'shopify'),(103,'manual'),(104,'walmart');
  INSERT INTO warehouse.warehouses(id,name,is_active) VALUES(1,'Old',1),(2,'Current',1),(3,'Dropship',1),(4,'Inactive',0);
  INSERT INTO channels.channel_warehouse_assignments VALUES(36,1,true),(103,1,true),(104,2,true);
  INSERT INTO channels.walmart_connections VALUES(104,1);
  INSERT INTO warehouse.fulfillment_nodes VALUES(11,1,'active'),(12,2,'active'),(13,3,'active'),(14,4,'active'),(15,1,'retired'),(16,NULL,'active');
  INSERT INTO inventory.inventory_publication_targets(id,channel_id) VALUES(1,36),(2,36),(3,103),(4,104);
  INSERT INTO inventory.publication_source_binding_versions VALUES(101,1,'sealed'),(102,1,'draft'),(201,2,'sealed'),(301,3,'sealed'),(401,4,'sealed');
  INSERT INTO inventory.publication_source_binding_heads VALUES(1,101,102),(2,201,NULL),(3,301,NULL),(4,401,NULL);
  INSERT INTO inventory.publication_source_binding_members VALUES(101,1,12),(102,1,11),(201,2,12),(201,2,14),(201,2,15),(201,2,16),(301,3,13),(401,4,12);
`;
