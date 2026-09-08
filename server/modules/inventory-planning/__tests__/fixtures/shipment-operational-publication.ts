import type { Pool } from "pg";

/** Reduced prerequisites inside the foundation suite's explicitly disposable DB.
 * The suite has no WMS shipping schema or lot ledger; actual234 is applied next.
 * No admission-fence implementation or publication guard is substituted here.
 */
export async function installOperationalPublicationPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA IF EXISTS wms CASCADE;
    DROP SCHEMA IF EXISTS oms CASCADE;
    CREATE SCHEMA wms; CREATE SCHEMA oms;
    ALTER TABLE warehouse.warehouse_locations ADD COLUMN pick_sequence integer;
    CREATE TABLE wms.orders(id integer PRIMARY KEY,warehouse_id integer NOT NULL REFERENCES warehouse.warehouses,
      warehouse_status text NOT NULL DEFAULT 'ready_to_ship',on_hold integer NOT NULL DEFAULT 0,cancelled_at timestamp);
    CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer NOT NULL REFERENCES wms.orders);
    CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer NOT NULL REFERENCES wms.orders,
      status text NOT NULL DEFAULT 'shipped',held boolean NOT NULL DEFAULT false,requires_review boolean NOT NULL DEFAULT false,
      review_reason text,shipment_purpose text NOT NULL DEFAULT 'customer_fulfillment',replaces_shipment_id integer,
      cancelled_at timestamp,voided_at timestamp,replacement_authorized_at timestamp,replacement_authorized_by text);
    CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY,shipment_id integer NOT NULL REFERENCES wms.outbound_shipments,
      order_item_id integer REFERENCES wms.order_items,product_variant_id integer NOT NULL REFERENCES catalog.product_variants,
      qty integer NOT NULL,from_location_id integer,shipment_item_purpose text NOT NULL,
      replacement_for_order_item_id integer REFERENCES wms.order_items,correction_for_shipment_item_id integer,
      provider_membership_state text NOT NULL DEFAULT 'authoritative');
    CREATE TABLE wms.physical_shipments(id bigint PRIMARY KEY,status text);
    CREATE TABLE wms.physical_shipment_items(id bigint PRIMARY KEY,physical_shipment_id bigint,
      legacy_wms_shipment_item_id integer REFERENCES wms.outbound_shipment_items,wms_order_item_id integer,
      product_variant_id integer,quantity_shipped integer,shipment_item_purpose text,
      replacement_for_order_item_id integer,correction_for_physical_shipment_item_id bigint,package_allocation_entry_id bigint);
    CREATE TABLE wms.physical_shipment_item_quantity_adjustments(id bigint PRIMARY KEY,physical_shipment_item_id bigint);
    CREATE TABLE inventory.inventory_lots(id integer PRIMARY KEY,warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations,
      product_variant_id integer NOT NULL REFERENCES catalog.product_variants,qty_on_hand integer NOT NULL,
      qty_reserved integer NOT NULL,qty_picked integer NOT NULL,status text NOT NULL,received_at timestamp NOT NULL,unit_cost_mills bigint NOT NULL);
    CREATE TABLE inventory.inventory_transactions(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_type text NOT NULL,product_variant_id integer,from_location_id integer,variant_qty_delta integer,
      variant_qty_before integer,variant_qty_after integer,reserved_qty_delta integer,source_state text,target_state text,
      order_id integer,order_item_id integer,shipment_id integer,shipment_item_id integer,reference_type text,
      reference_id text,total_cost_mills bigint,user_id text,notes text,created_at timestamp,voided_at timestamp);
    CREATE TABLE oms.order_item_costs(id integer PRIMARY KEY,qty integer,total_cost_mills bigint);
    CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE=format('%s is append-only',TG_TABLE_NAME); END; $$;
  `);
}
