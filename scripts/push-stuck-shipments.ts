import "dotenv/config";
import { db } from "../server/db";
import { createServices } from "../server/services";
import { sql } from "drizzle-orm";

async function run() {
  const services = createServices(db);
  
  // Find all planned outbound shipments that do NOT have a shipstation order ID
  const result: any = await db.execute(sql`
    SELECT id
    FROM wms.outbound_shipments
    WHERE status = 'planned'
      AND shipstation_order_id IS NULL
    ORDER BY created_at ASC
  `);
  
  const shipmentIds = result.rows.map((r: any) => r.id);
  console.log(`Found ${shipmentIds.length} stuck planned shipments to push.`);
  
  let success = 0;
  let failed = 0;
  
  for (const id of shipmentIds) {
    try {
      console.log(`Pushing shipment ${id}...`);
      await services.shipStation.pushShipment(id);
      success++;
    } catch (err: any) {
      console.error(`Failed to push shipment ${id}: ${err.message}`);
      failed++;
    }
    // rate limit
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`Sweep complete. Success: ${success}, Failed: ${failed}`);
  process.exit(0);
}

run().catch(console.error);
