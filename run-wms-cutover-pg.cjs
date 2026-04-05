require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("Starting WMS Full Cutover...");
  
  try {
    console.log("1. Injecting matching legacy columns into wms.orders to prevent mapping faults...");
    await pool.query(`
      ALTER TABLE wms.orders
      ADD COLUMN IF NOT EXISTS source_table_id varchar(100),
      ADD COLUMN IF NOT EXISTS shopify_order_id varchar(50),
      ADD COLUMN IF NOT EXISTS financial_status varchar(30),
      ADD COLUMN IF NOT EXISTS shopify_fulfillment_status varchar(30),
      ADD COLUMN IF NOT EXISTS cancelled_at timestamp,
      ADD COLUMN IF NOT EXISTS notes text,
      ADD COLUMN IF NOT EXISTS short_reason text,
      ADD COLUMN IF NOT EXISTS metadata jsonb,
      ADD COLUMN IF NOT EXISTS legacy_order_id varchar(100),
      ADD COLUMN IF NOT EXISTS shopify_created_at timestamp,
      ADD COLUMN IF NOT EXISTS sla_due_at timestamp,
      ADD COLUMN IF NOT EXISTS sla_status varchar(20),
      ADD COLUMN IF NOT EXISTS exception_at timestamp,
      ADD COLUMN IF NOT EXISTS exception_resolution varchar(20),
      ADD COLUMN IF NOT EXISTS exception_resolved_at timestamp,
      ADD COLUMN IF NOT EXISTS exception_resolved_by varchar(100),
      ADD COLUMN IF NOT EXISTS exception_notes text;
    `);

    console.log("2. Injecting matching legacy columns into wms.order_items...");
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema='wms' AND table_name='order_items' AND column_name='wms_order_id'
        ) THEN 
          ALTER TABLE wms.order_items RENAME COLUMN wms_order_id TO order_id;
        END IF;
      END $$;
    `);
    await pool.query(`
      ALTER TABLE wms.order_items
      ADD COLUMN IF NOT EXISTS shopify_line_item_id varchar(50),
      ADD COLUMN IF NOT EXISTS source_item_id varchar(100);
    `);

    console.log("3. Replicating wms.orders data...");
    await pool.query(`
      INSERT INTO wms.orders (
        id, channel_id, source, external_order_id, order_number, customer_name, customer_email, 
        shipping_name, shipping_address, shipping_city, shipping_state, shipping_postal_code, shipping_country, 
        warehouse_id, priority, warehouse_status, on_hold, held_at, assigned_picker_id, batch_id, 
        combined_group_id, combined_role, item_count, unit_count, picked_count, order_placed_at, created_at, 
        started_at, completed_at, source_table_id, shopify_order_id, financial_status, shopify_fulfillment_status, 
        cancelled_at, notes, short_reason, metadata, legacy_order_id, shopify_created_at, sla_due_at, sla_status, 
        exception_at, exception_resolution, exception_resolved_at, exception_resolved_by, exception_notes
      ) OVERRIDING SYSTEM VALUE
      SELECT 
        id, channel_id, source, external_order_id, order_number, customer_name, customer_email, 
        shipping_name, shipping_address, shipping_city, shipping_state, shipping_postal_code, shipping_country, 
        warehouse_id, priority, warehouse_status, on_hold, held_at, assigned_picker_id, batch_id, 
        combined_group_id, combined_role, item_count, unit_count, picked_count, order_placed_at, created_at, 
        started_at, completed_at, source_table_id, shopify_order_id, financial_status, shopify_fulfillment_status, 
        cancelled_at, notes, short_reason, metadata, legacy_order_id, shopify_created_at, sla_due_at, sla_status, 
        exception_at, exception_resolution, exception_resolved_at, exception_resolved_by, exception_notes
      FROM public.orders
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("4. Replicating wms.order_items data...");
    await pool.query(`
      INSERT INTO wms.order_items (
        id, order_id, product_id, sku, name, image_url, barcode, quantity, picked_quantity, fulfilled_quantity, 
        status, location, zone, short_reason, picked_at, requires_shipping, shopify_line_item_id, source_item_id
      ) OVERRIDING SYSTEM VALUE
      SELECT 
        id, order_id, product_id, sku, name, image_url, barcode, quantity, picked_quantity, fulfilled_quantity, 
        status, location, zone, short_reason, picked_at, requires_shipping, shopify_line_item_id, source_item_id
      FROM public.order_items
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("5. Updating orders.storage.ts Raw SQL to target wms schema...");
    const fs = require('fs');
    let storageContent = fs.readFileSync('server/modules/orders/orders.storage.ts', 'utf8');
    storageContent = storageContent.replace(/FROM public\.orders/g, 'FROM wms.orders');
    storageContent = storageContent.replace(/FROM public\.order_items/g, 'FROM wms.order_items');
    fs.writeFileSync('server/modules/orders/orders.storage.ts', storageContent, 'utf8');

    console.log("Done. The Clean Break is fully complete.");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

run();
