import "dotenv/config";
import { db } from "../server/db";
import { createServices } from "../server/services";
import { sql } from "drizzle-orm";

async function run() {
  const orderId = Number(process.argv[2] || 149170);
  console.log(`=== Debugging ShipStation Push for Order ${orderId} ===`);
  
  const services = createServices(db);
  
  console.log("1. Checking ShipStation Configuration:", services.shipStation.isConfigured());
  
  console.log("2. Testing WMS Sync Path...");
  try {
    // We will bypass the 'already synced' check by directly invoking the logic
    const omsService = services.oms;
    const fullOmsOrder = await omsService.getOrderById(orderId);
    
    if (!fullOmsOrder) {
      console.log(`OMS Order ${orderId} not found by omsService.getOrderById!`);
      process.exit(1);
    }
    
    console.log(`Fetched OMS Order: ${fullOmsOrder.externalOrderNumber}, ${fullOmsOrder.lines?.length} lines`);
    
    console.log("3. Calling shipStation.pushOrder...");
    const result = await services.shipStation.pushOrder(fullOmsOrder);
    console.log("Push Result:", result);
    
  } catch (err: any) {
    console.error("ERROR during push:");
    console.error(err.stack);
  }
  
  process.exit(0);
}

run().catch(console.error);
