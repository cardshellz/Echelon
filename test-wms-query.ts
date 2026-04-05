import { orderMethods } from "./server/modules/orders/orders.storage";

async function test() {
  try {
    console.log("Fetching Pick Queue via updated wms.orders schema...");
    const orders = await orderMethods.getPickQueueOrders();
    console.log(`Successfully fetched ${orders.length} wms orders!`);
    if (orders.length > 0) {
      console.log(`Sample: ID=${orders[0].id}, Priority=${orders[0].priority}`);
    }
    process.exit(0);
  } catch(e) {
    console.error("SQL Error:", e);
    process.exit(1);
  }
}

test();
