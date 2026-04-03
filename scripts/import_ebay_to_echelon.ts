import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db, pool } from "../server/db.js";
import { productAssets } from "../shared/schema.js";
import { eq } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("Starting Echelon Direct eBay Image Import...");

  const res = await pool.query("SELECT access_token FROM ebay_oauth_tokens ORDER BY id DESC LIMIT 1");
  const ebayToken = res.rows.length > 0 ? res.rows[0].access_token : null;
  if (!ebayToken) {
    console.error("Missing eBay token.");
    process.exit(1);
  }

  const ebayMapping = await db.execute(`
    SELECT DISTINCT p.id as p_id, cl.external_product_id as item_id 
    FROM channel_listings cl 
    JOIN channels c ON c.id = cl.channel_id 
    JOIN product_variants pv ON pv.id = cl.product_variant_id 
    JOIN products p ON pv.product_id = p.id
    WHERE c.provider = 'ebay' AND cl.external_product_id IS NOT NULL
  `);

  console.log(`Analyzing ${ebayMapping.rows.length} Echelon products tied to eBay...`);

  let added = 0;
  for (const r of ebayMapping.rows) {
    const pid = r.p_id as number;
    const item_id = r.item_id as string;

    const assets = await db.select().from(productAssets).where(eq(productAssets.productId, pid));
    if (assets.length > 0) continue; // Already has image

    const ebayGroupRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${item_id}|0`, {
      headers: { "Authorization": `Bearer ${ebayToken}` }
    });

    if (ebayGroupRes.ok) {
      const ebayData = await ebayGroupRes.json();
      const ebayImageUrl = ebayData.image?.imageUrl;
      if (ebayImageUrl) {
        console.log(`Found eBay Image for Product ${pid}: ${ebayImageUrl}`);
        await db.insert(productAssets).values({
          productId: pid,
          assetType: "image",
          url: ebayImageUrl,
          position: 0,
          isPrimary: 1,
          storageType: "url"
        });
        added++;
      } else {
        console.log(`No image found on eBay for product ${pid}`);
      }
    } else {
       // try legacy format
       const legacyRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/v1|${item_id}`, {
          headers: { "Authorization": `Bearer ${ebayToken}` }
       });
       if (legacyRes.ok) {
           const legacyData = await legacyRes.json();
           const legacyUrl = legacyData.image?.imageUrl;
           if (legacyUrl) {
             console.log(`Found legacy eBay Image for Product ${pid}: ${legacyUrl}`);
             await db.insert(productAssets).values({
               productId: pid,
               assetType: "image",
               url: legacyUrl,
               position: 0,
               isPrimary: 1,
               storageType: "url"
             });
             added++;
           }
       } else {
           console.log(`Failed to fetch from eBay for product ${pid}: ${await legacyRes.text()}`);
       }
    }
  }

  console.log(`=== Done! Added ${added} images directly into Echelon DB ===`);
}

run().catch(console.error).finally(() => process.exit(0));
