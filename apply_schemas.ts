import { Client } from 'pg';
import 'dotenv/config';

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  console.log("Connected to DB. Applying DDL schema moves...");

  const stmts = [
    // Move to Membership Spoke
    `ALTER TABLE IF EXISTS "public"."plans" SET SCHEMA "membership";`,
    `ALTER TABLE IF EXISTS "public"."members" SET SCHEMA "membership";`,
    `ALTER TABLE IF EXISTS "public"."member_subscriptions" SET SCHEMA "membership";`,
    
    // Membership priority config
    `ALTER TABLE "membership"."plans" ADD COLUMN IF NOT EXISTS "priority_modifier" integer DEFAULT 5 NOT NULL;`,

    // Move to WMS Spoke
    `ALTER TABLE IF EXISTS "public"."picking_logs" SET SCHEMA "wms";`,
    `ALTER TABLE IF EXISTS "public"."outbound_shipments" SET SCHEMA "wms";`,
    `ALTER TABLE IF EXISTS "public"."outbound_shipment_items" SET SCHEMA "wms";`,
    `ALTER TABLE IF EXISTS "wms"."picking_logs" SET SCHEMA "wms";`, // In case it was already moved

    // WMS Priority type change
    `ALTER TABLE "wms"."orders" ALTER COLUMN "priority" TYPE integer USING ("priority"::integer);`,
    `ALTER TABLE "wms"."orders" ALTER COLUMN "priority" SET DEFAULT 100;`,

    // Move to OMS Hub
    `ALTER TABLE IF EXISTS "public"."fulfillment_routing_rules" SET SCHEMA "oms";`,
    `ALTER TABLE IF EXISTS "public"."order_item_costs" SET SCHEMA "oms";`,
    `ALTER TABLE IF EXISTS "public"."order_item_financials" SET SCHEMA "oms";`,

    // OMS shipping columns
    `ALTER TABLE "oms"."oms_orders" ADD COLUMN IF NOT EXISTS "shipping_method" varchar(200);`,
    `ALTER TABLE "oms"."oms_orders" ADD COLUMN IF NOT EXISTS "shipping_method_code" varchar(100);`
  ];

  for (const stmt of stmts) {
    try {
      await client.query(stmt);
      console.log("Success:", stmt);
    } catch (e: any) {
      if (e.message.includes("does not exist") || e.message.includes("invalid input syntax for type integer")) {
        console.warn("Skipped (ok):", stmt, e.message);
      } else {
        console.error("Error:", stmt, e.message);
      }
    }
  }

  await client.end();
  console.log("Done.");
}

run().catch(console.error);
