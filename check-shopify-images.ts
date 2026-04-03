import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { channelConnections, channels } from "./shared/schema";
import { eq } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const allConnections = await db
    .select({
      provider: channels.provider,
      shopDomain: channelConnections.shopDomain,
      accessToken: channelConnections.accessToken,
    })
    .from(channelConnections)
    .innerJoin(channels, eq(channels.id, channelConnections.channelId));

  const conn = allConnections.find(c => c.provider === "shopify");
  if (!conn) return console.log("no shopify conn");

  // Fetch products
  const res = await fetch(`https://${conn.shopDomain}/admin/api/2024-01/products.json?limit=250&fields=id,title,images,variants`, {
    headers: { "X-Shopify-Access-Token": conn.accessToken }
  });

  const data = await res.json();
  console.log("SHOPIFY API RESPONSE:", data);
  const products = data.products || [];
  console.log(`Total Shopify products: ${products.length}`);
  
  // Find duplicate titles
  const titles = new Map<string, any[]>();
  for (const p of products) {
    if (!titles.has(p.title)) titles.set(p.title, []);
    titles.get(p.title)!.push(p);
  }

  let dupesCount = 0;
  for (const [t, pList] of titles) {
    if (pList.length > 1) {
      dupesCount++;
      console.log(`Duplicate: ${t} -> ${pList.map(p => p.id).join(', ')}`);
      for (const p of pList) {
        console.log(`  ID ${p.id}: ${p.images?.length || 0} images`);
      }
    }
  }
  
  console.log(`Duplicates found: ${dupesCount}`);
  
  const noImageProducts = products.filter(p => !p.images || p.images.length === 0);
  console.log(`Products with no images: ${noImageProducts.length}`);

  process.exit(0);
}
run();
