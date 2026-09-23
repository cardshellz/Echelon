import { readFileSync } from "node:fs";
import type { Pool } from "pg";

function table(file: string, marker: string): string {
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(marker);
  const result = source.slice(start).match(/^[\s\S]*?\r?\n\);/);
  if (start < 0 || !result) throw new Error(`Migration table missing: ${marker}`);
  return result[0];
}
function statement(file: string, marker: string): string {
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(marker);
  const end = source.indexOf(";", start);
  if (start < 0 || end < 0) throw new Error(`Migration statement missing: ${marker}`);
  return source.slice(start, end + 1);
}

/** Queried relations come from retained migration DDL. Unread FK parents are
 * minimal fixtures. This is a targeted schema test, not a historical migration
 * chain replay; compatibility projection columns are copied explicitly below. */
export async function createInspectionTestSchema(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS returns, wms, oms, channels, catalog, warehouse, dropship, inventory CASCADE;
    CREATE SCHEMA returns; CREATE SCHEMA wms; CREATE SCHEMA oms; CREATE SCHEMA channels;
    CREATE SCHEMA catalog; CREATE SCHEMA warehouse; CREATE SCHEMA dropship; CREATE SCHEMA inventory;`);
  for (const name of ["channels", "channel_connections"]) {
    await pool.query(table("migrations/0001_past_molly_hayes.sql", `CREATE TABLE "${name}" (`)
      .replace(`CREATE TABLE "${name}"`, `CREATE TABLE channels."${name}"`));
  }
  for (const marker of ['CREATE TABLE "oms"."oms_orders" (', 'CREATE TABLE "oms"."oms_order_lines" (',
    'CREATE TABLE "wms"."orders" (', 'CREATE TABLE "wms"."order_items" (']) {
    await pool.query(table("migrations/0002_concerned_darwin.sql", marker));
  }
  await pool.query(`ALTER TABLE wms.order_items RENAME COLUMN wms_order_id TO order_id;
    ALTER TABLE wms.order_items ALTER COLUMN oms_order_line_id TYPE BIGINT;
    ALTER TABLE wms.order_items ADD CONSTRAINT inspection_item_order_fk FOREIGN KEY (order_id) REFERENCES wms.orders(id);
    ALTER TABLE wms.order_items ADD CONSTRAINT inspection_item_line_fk FOREIGN KEY (oms_order_line_id) REFERENCES oms.oms_order_lines(id);`);
  // These two legacy columns are retained in current orders.schema.ts and
  // originate in the 0001 owner tables (the 0002 WMS projection omitted them).
  const legacy = readFileSync("migrations/0001_past_molly_hayes.sql", "utf8");
  for (const [relation, column] of [["orders", "source_table_id"], ["order_items", "source_item_id"]]) {
    const definition = legacy.match(new RegExp(`"${column}" varchar\\(100\\)`))?.[0];
    if (!definition) throw new Error(`Legacy source column missing: ${column}`);
    await pool.query(`ALTER TABLE wms.${relation} ADD COLUMN ${definition}`);
  }
  await pool.query(`CREATE TABLE catalog.product_variants (id INTEGER PRIMARY KEY);
    CREATE TABLE warehouse.warehouses (id INTEGER PRIMARY KEY);
    CREATE TABLE wms.outbound_shipments (id INTEGER PRIMARY KEY);
    CREATE TABLE wms.outbound_shipment_items (id INTEGER PRIMARY KEY, shipment_id INTEGER REFERENCES wms.outbound_shipments(id));
    CREATE TABLE dropship.dropship_vendors (id INTEGER PRIMARY KEY);
    CREATE TABLE dropship.dropship_store_connections (id INTEGER PRIMARY KEY);`);
  await pool.query(readFileSync("migrations/066_shipping_config_columns.sql", "utf8"));
  await pool.query(table("migrations/0086_dropship_v2_foundation.sql", "CREATE TABLE IF NOT EXISTS dropship.dropship_order_intake ("));
  await pool.query(table("migrations/0001_past_molly_hayes.sql", 'CREATE TABLE "inventory_transactions" (')
    .replace('CREATE TABLE "inventory_transactions"', 'CREATE TABLE inventory."inventory_transactions"'));
  // Actual 0002 removal statements retire unused legacy required fields.
  for (const column of ["inventory_item_id", "variant_id", "warehouse_location_id", "base_qty_delta", "base_qty_before", "base_qty_after"]) {
    await pool.query(statement("migrations/0002_concerned_darwin.sql", `ALTER TABLE "inventory_transactions" DROP COLUMN "${column}"`)
      .replace('ALTER TABLE "inventory_transactions"', 'ALTER TABLE inventory."inventory_transactions"'));
  }
  await pool.query(readFileSync("migrations/115_fulfillment_canonical_shadow_tables.sql", "utf8"));
  const foundation = "migrations/0593_fulfillment_authority_cutover_foundation.sql";
  for (const marker of [
    "ALTER TABLE wms.physical_shipments\n  ALTER COLUMN shipment_request_id DROP NOT NULL",
    "ALTER TABLE wms.physical_shipment_items\n  ADD COLUMN IF NOT EXISTS legacy_wms_shipment_item_id",
    "ALTER TABLE wms.physical_shipment_items\n  ALTER COLUMN shipment_request_item_id DROP NOT NULL",
    "ALTER TABLE oms.channel_fulfillment_push_items\n  ADD COLUMN IF NOT EXISTS physical_shipment_item_id",
  ]) await pool.query(statement(foundation, marker));
  await pool.query(statement("migrations/183_omission_correction_shipment_item_authority.sql",
    "ALTER TABLE wms.physical_shipment_items\n  ADD COLUMN IF NOT EXISTS correction_for_physical_shipment_item_id"));
  await pool.query(readFileSync("migrations/182_physical_shipment_item_quantity_adjustments.sql", "utf8"));
  for (const name of ["channel_fulfillment_receipts", "channel_fulfillment_receipt_items"]) {
    await pool.query(table(foundation, `CREATE TABLE IF NOT EXISTS oms.${name} (`));
  }
  for (const name of ["shipping_provider_labels", "shipping_provider_label_links", "carrier_tracking_events",
    "carrier_tracking_event_matches", "carrier_tracking_reconciliation_state"]) {
    await pool.query(table("migrations/154_carrier_tracking_event_authority.sql", `CREATE TABLE IF NOT EXISTS wms.${name} (`));
  }
  const direction = readFileSync("migrations/0603_shipping_provider_label_direction.sql", "utf8");
  await pool.query(direction.slice(0, direction.indexOf("-- Previous remediation")));
  await pool.query(readFileSync("migrations/062_returns.sql", "utf8"));
  await pool.query(readFileSync("migrations/131_refund_line_disposition_authority.sql", "utf8"));
  await pool.query(readFileSync("migrations/0699_customer_return_authorizations.sql", "utf8"));
}

export async function seedInspectionTestSchema(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE channels.channels, channels.channel_connections, oms.oms_orders, oms.oms_order_lines,
    wms.orders, wms.order_items, inventory.inventory_transactions, dropship.dropship_order_intake,
    wms.returns, wms.return_items, returns.customer_return_authorizations,
    wms.shipping_provider_labels, wms.carrier_tracking_events, wms.physical_shipments,
    wms.fulfillment_plans RESTART IDENTITY CASCADE;
    INSERT INTO channels.channels (id,name,type,provider,status) OVERRIDING SYSTEM VALUE VALUES
      (36,'Approved test shop','internal','shopify','active'), (37,'Other shop','internal','shopify','active');
    INSERT INTO channels.channel_connections (id,channel_id,shop_domain,access_token) OVERRIDING SYSTEM VALUE VALUES
      (4,36,'test-shop.myshopify.com','synthetic-secret'), (5,37,'other-shop.myshopify.com','other-synthetic-secret');
    INSERT INTO oms.oms_orders (id,channel_id,external_order_id,external_order_number,ordered_at,ship_to_country) OVERRIDING SYSTEM VALUE VALUES
      (100,36,'1000','#TEST-1','2026-09-01','US'), (200,37,'2000','#TEST-1','2026-09-01','CA');
    INSERT INTO oms.oms_order_lines (id,order_id,external_line_item_id,title,sku,quantity,requires_shipping) OVERRIDING SYSTEM VALUE VALUES
      (101,100,'500','Same title','SAME',3,true), (102,100,'501','Same title','SAME',1,true),
      (103,100,'502','Digital item','DIGITAL',1,false), (201,200,'600','Other store item','SAME',1,true);
    INSERT INTO wms.orders (id,oms_fulfillment_order_id,channel_id,source,external_order_id,order_number,customer_name,warehouse_status) OVERRIDING SYSTEM VALUE VALUES
      (201,'100',36,'oms','1000','TEST-PART-1','Synthetic','shipped'),
      (202,'100',36,'oms','1000','TEST-PART-2','Synthetic','shipped'),
      (203,'200',37,'oms','2000','OTHER','Synthetic','shipped');
    INSERT INTO wms.order_items (id,order_id,oms_order_line_id,source_item_id,sku,name,quantity,fulfilled_quantity) OVERRIDING SYSTEM VALUE VALUES
      (301,201,101,'500','SAME','Same title',2,2), (302,202,101,'500','SAME','Same title',1,1),
      (303,202,102,'501','SAME','Same title',1,1), (304,203,201,'600','SAME','Other',1,1);`);
}
