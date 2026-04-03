import { db } from "../server/db";
import { orderMethods } from "../server/modules/orders/orders.storage";
import { PickingService } from "../server/modules/orders/picking.service";
import * as dotenv from "dotenv";

dotenv.config();

async function run() {
  console.log("Testing claimOrder via PickingService...");
  try {
    const pickingService = new PickingService(orderMethods, null as any);
    
    console.log("Fetching first ready order...");
    const queue = await orderMethods.getPickQueueOrders();
    const readyOrder = queue.find((o: any) => o.warehouseStatus === 'in_progress' || o.warehouseStatus === 'ready');
    
    if (!readyOrder) {
      console.log("No orders found to test claim.");
      process.exit(0);
    }
    
    console.log(`Found target order ${readyOrder.id}. Testing releaseOrder...`);
    try {
        await pickingService.releaseOrder(readyOrder.id, { resetProgress: true, reason: "test release", deviceType: "auto", sessionId: "123" });
        console.log("Release Success.");
    } catch (e: any) {
        console.error("releaseOrder FAILED:", e);
    }
    
    console.log(`Testing claimOrder...`);
    try {
        const result = await pickingService.claimOrder(readyOrder.id, "test-picker-id", "auto", "123");
        console.log("Claim Success:", result ? "OK" : "NULL");
    } catch (e: any) {
        console.error("claimOrder FAILED:", e);
    }
    
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

run();
