import { randomUUID } from "node:crypto";
import pg from "pg";

/** Reduced named-schema query fixture, not production migration/trigger proof. */
export const inventoryCutoverOwnerFixtureSql = `
  CREATE SCHEMA inventory;
  CREATE TABLE inventory.inventory_levels (
    id integer PRIMARY KEY, warehouse_location_id integer NOT NULL,
    product_variant_id integer NOT NULL, variant_qty integer NOT NULL,
    reserved_qty integer NOT NULL, picked_qty integer NOT NULL, packed_qty integer NOT NULL
  );
  CREATE TABLE inventory.build_orders (id integer PRIMARY KEY, status varchar(20) NOT NULL, warehouse_id integer NOT NULL);
  CREATE TABLE inventory.build_order_components (
    id integer PRIMARY KEY, build_order_id integer NOT NULL,
    component_variant_id integer NOT NULL, source_location_id integer
  );
  CREATE TABLE inventory.inventory_lots (
    id integer PRIMARY KEY, product_variant_id integer NOT NULL,
    warehouse_location_id integer NOT NULL, qty_reserved integer NOT NULL
  );
  CREATE TABLE inventory.build_component_reservations (
    id integer PRIMARY KEY, build_order_component_id integer NOT NULL,
    inventory_lot_id integer NOT NULL, reserved_qty integer NOT NULL,
    consumed_qty integer NOT NULL, released_qty integer NOT NULL,
    reservation_owner varchar(30) NOT NULL,
    availability_claim_id bigint, availability_claim_lot_allocation_id bigint
  );
  CREATE TABLE inventory.availability_claims (id bigint PRIMARY KEY, status varchar(30) NOT NULL, order_id integer NOT NULL);
  CREATE TABLE inventory.availability_claim_lines (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL, order_item_id integer NOT NULL, target_variant_id integer NOT NULL
  );
  CREATE TABLE inventory.availability_claim_resources (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL, claim_line_id bigint NOT NULL,
    warehouse_id integer NOT NULL, warehouse_location_id integer NOT NULL,
    inventory_level_id integer NOT NULL, source_variant_id integer NOT NULL,
    claimed_qty bigint NOT NULL, released_qty bigint NOT NULL,
    consumed_qty bigint NOT NULL, picked_qty bigint NOT NULL
  );
  CREATE TABLE inventory.availability_claim_lot_allocations (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL, claim_resource_id bigint NOT NULL,
    inventory_lot_id integer NOT NULL, claimed_qty bigint NOT NULL,
    released_qty bigint NOT NULL, consumed_qty bigint NOT NULL, picked_qty bigint NOT NULL
  );
`;

export interface InventoryCutoverTestDatabase {
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Never uses the supplied database for tables: creates a unique per-suite database. */
export async function createInventoryCutoverTestDatabase(
  connectionString: string | undefined,
  disposable: boolean,
  fixtureSql: string = inventoryCutoverOwnerFixtureSql,
): Promise<InventoryCutoverTestDatabase> {
  if (!connectionString || !disposable) throw new Error("Explicit disposable database configuration required.");
  const databaseName = `inventory_cutover_${randomUUID().replaceAll("-", "")}`;
  if (!/^inventory_cutover_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe test database name.");
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  let created = false;
  let pool: pg.Pool | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const dedicatedUrl = new URL(connectionString);
    dedicatedUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: dedicatedUrl.toString(), max: 4 });
    await pool.query(fixtureSql);
    return { pool, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Cutover fixture setup and cleanup failed."); }
    throw error;
  }
}
