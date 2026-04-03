import "dotenv/config";
import { db, sql } from "./server/storage/base";

async function run() {
  try {
    const resSettings = await db.execute(sql`SELECT shopify_shop_domain, shopify_access_token FROM app_settings LIMIT 1`);
    const shop = resSettings.rows[0];
    if (shop) {
      process.env.SHOPIFY_SHOP_DOMAIN = shop.shopify_shop_domain;
      process.env.SHOPIFY_ACCESS_TOKEN = shop.shopify_access_token;
    }
    
    console.log("Setting up selling plans for GID: gid://shopify/Product/10898153373855");
    
    // Dynamic import to ensure ENV variables are injected before module resolution
    const { createSellingPlanGroup } = await import("./server/modules/subscriptions/selling-plan.service.ts");
    
    const res = await createSellingPlanGroup("gid://shopify/Product/10898153373855");
    console.log("SUCCESS:", JSON.stringify(res, null, 2));
  } catch(e) {
    console.error("ERROR:", e);
  }
  process.exit(0);
}
run();
