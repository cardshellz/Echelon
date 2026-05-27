import "dotenv/config";
import { db } from "../server/db";
import { createServices } from "../server/services";
import { sql } from "drizzle-orm";

async function run() {
  const shipmentId = Number(process.argv[2]);
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    console.error("Usage: npx tsx scripts/debug-ss-push.ts <wms_shipment_id>");
    process.exit(1);
  }
  console.log(`=== Debugging ShipStation Push for WMS Shipment ${shipmentId} ===`);
  
  const services = createServices(db);
  
  console.log("1. Checking ShipStation Configuration:", services.shipStation.isConfigured());
  
  console.log("2. Checking WMS shipment...");
  try {
    const shipment = await db.execute(sql`
      SELECT id, order_id, status, shipstation_order_id, shipstation_order_key
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);

    if (shipment.rows.length === 0) {
      console.log(`WMS shipment ${shipmentId} not found`);
      process.exit(1);
    }

    console.log("Shipment:", shipment.rows[0]);

    console.log("3. Calling shipStation.pushShipment...");
    const result = await services.shipStation.pushShipment(shipmentId);
    console.log("Push Result:", result);
    
  } catch (err: any) {
    console.error("ERROR during push:");
    console.error(err.stack);
  }
  
  process.exit(0);
}

run().catch(console.error);
