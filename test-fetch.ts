import "dotenv/config";
import { db, sql } from "./server/storage/base";
import { getShopifyConfig } from "./server/modules/integrations/shopify";

async function testFetch() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const rawOrderResult = await db.execute(sql`
    SELECT id, shop_domain FROM shopify_orders LIMIT 1
  `);
  
  if (rawOrderResult.rows.length === 0) {
    console.log("No shopify orders");
    return;
  }
  
  const shopifyOrderId = rawOrderResult.rows[0].id as string;
  const orderDomain = rawOrderResult.rows[0].shop_domain;

  const connResult = await db.execute(sql`
    SELECT * FROM channel_connections
    WHERE shop_domain ILIKE ${'%' + orderDomain + '%'}
    LIMIT 1
  `);

  let token, storeUrl;
  if (connResult.rows.length > 0) {
    token = connResult.rows[0].access_token;
    storeUrl = connResult.rows[0].shop_domain;
  } else {
    try {
      const config = getShopifyConfig();
      token = config.accessToken;
      storeUrl = config.domain;
    } catch {}
  }

  const parsedShopifyId = shopifyOrderId.replace("gid://shopify/Order/", "");
  const url = `https://${storeUrl}/admin/api/2024-10/orders/${parsedShopifyId}.json`;
  
  console.log(`Fetching: ${url}`);
  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token || "",
      "Content-Type": "application/json",
    },
  });
  
  console.log(`Status: ${response.status} ${response.statusText}`);
  const text = await response.text();
  console.log("Body:", text.substring(0, 100));
}

testFetch().catch(console.error);
