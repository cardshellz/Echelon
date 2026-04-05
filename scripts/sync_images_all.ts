import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, inArray, and } from "drizzle-orm";
import { 
  channelConnections, channels, channelFeeds, products, productVariants, productAssets, channelListings
} from "../shared/schema";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const db = drizzle(pool);

async function downloadImageAsBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function getTokens() {
  const allConnections = await db
    .select({
      provider: channels.provider,
      shopDomain: channelConnections.shopDomain,
      accessToken: channelConnections.accessToken,
      channelId: channels.id,
    })
    .from(channelConnections)
    .innerJoin(channels, eq(channels.id, channelConnections.channelId));

  const shopifyConns = new Map(allConnections.filter(c => c.provider === "shopify").map(c => [c.channelId, c]));
  const ebayConn = allConnections.find(c => c.provider === "ebay");

  let ebayToken = ebayConn?.accessToken;
  if (!ebayToken) {
    const res = await pool.query("SELECT access_token FROM ebay_oauth_tokens ORDER BY id DESC LIMIT 1");
    if (res.rows.length > 0) ebayToken = res.rows[0].access_token;
  }
  return { shopifyConns, ebayToken };
}

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("Starting Robust Image Sync (Ebay -> Echelon -> Shopify)...");
  
  const tokens = await getTokens();
  if (!tokens.ebayToken || tokens.shopifyConns.size === 0) {
    console.error("Missing credentials.");
    process.exit(1);
  }

  const shopifyListings = await db.execute(`
    SELECT DISTINCT p.id as p_id, cl.external_product_id as channel_product_id, pv.sku, cl.external_variant_id as channel_variant_id, cl.channel_id
    FROM channel_listings cl
    JOIN channels c ON c.id = cl.channel_id
    JOIN product_variants pv ON pv.id = cl.product_variant_id
    JOIN products p ON p.id = pv.product_id
    WHERE c.provider = 'shopify' AND cl.external_product_id IS NOT NULL
  `);

  const ebayMapping = await db.execute(`
    SELECT cl.external_product_id as item_id, pv.sku 
    FROM channel_listings cl 
    JOIN channels c ON c.id = cl.channel_id 
    JOIN product_variants pv ON pv.id = cl.product_variant_id 
    WHERE c.provider = 'ebay' AND cl.external_product_id IS NOT NULL
  `);
  const skuToEbay = new Map<string, string>();
  for (const r of ebayMapping.rows) {
     if (r.sku && r.item_id) skuToEbay.set(r.sku as string, r.item_id as string);
  }

  // Group by Echelon Product ID
  const groupedProducts = new Map<number, { shopifyId: string, channelId: number, variants: any[] }>();
  for (const r of shopifyListings.rows) {
    const pid = r.p_id as number;
    if (!groupedProducts.has(pid)) {
       groupedProducts.set(pid, { shopifyId: r.channel_product_id as string, channelId: r.channel_id as number, variants: [] });
    }
    groupedProducts.get(pid)?.variants.push(r);
  }

  console.log(`Analyzing ${groupedProducts.size} active products...`);
  
  let pushedFromEchelonCount = 0;
  let downloadedFromEbayCount = 0;
  let skippedCount = 0;

  for (const [productId, data] of groupedProducts.entries()) {
    try {
      const shId = data.shopifyId;
      const shConn = tokens.shopifyConns.get(data.channelId);
      if (!shConn || !shConn.accessToken || !shConn.shopDomain) {
         console.warn(`No active Shopify connection for channel ${data.channelId}`);
         continue;
      }
      
      // Check Echelon Product Assets
      const assets = await db.select().from(productAssets).where(eq(productAssets.productId, productId));
      
      // Check Shopify's current images
      const shRes = await fetch(`https://${shConn.shopDomain}/admin/api/2024-01/products/${shId}.json?fields=images`, {
        headers: { "X-Shopify-Access-Token": shConn.accessToken }
      });
      const shData = await shRes.json();
      const shImagesCount = shData?.product?.images?.length || 0;

      // Scenario 1: Echelon has images, Shopify is missing them.
      let hasValidAssets = false;
      if (assets.length > 0 && shImagesCount === 0) {
        console.log(`Product ${productId} has ${assets.length} images in Echelon, but 0 in Shopify. Pushing...`);
        for (const asset of assets) {
           if (!asset.url) continue;
           try {
             const base64Data = await downloadImageAsBase64(asset.url);
             const postRes = await fetch(`https://${shConn.shopDomain}/admin/api/2024-01/products/${shId}/images.json`, {
               method: "POST",
               headers: { "X-Shopify-Access-Token": shConn.accessToken, "Content-Type": "application/json" },
               body: JSON.stringify({ image: { attachment: base64Data } })
             });
             if (!postRes.ok) {
                console.error(`Failed to push Echelon image for ${productId}:`, await postRes.text());
             } else {
                pushedFromEchelonCount++;
                hasValidAssets = true;
             }
           } catch (err: any) {
             if (err.message.includes('404') || err.message.includes('403')) {
                console.log(`Dead CDN link detected for product ${productId}. Deleting from Echelon DB...`);
                await db.delete(productAssets).where(eq(productAssets.id, asset.id));
             } else {
                throw err;
             }
           }
           await new Promise(r => setTimeout(r, 600));
        }
        
        if (hasValidAssets) continue; // At least one image worked
        console.log(`All Echelon images for ${productId} were 404. Falling back to eBay...`);
      }

      // Scenario 2: Echelon is missing images (wiped out or dead), and Shopify is missing them too.
      if (!hasValidAssets && shImagesCount === 0) {
         console.log(`Product ${productId} has 0 images everywhere. Attempting eBay rescue...`);
         
         // Pick the first SKU that has an eBay mapping
         let ebayUrl = null;
         let variantIdMatch = null;
         for (const v of data.variants) {
            const sku = v.sku;
            if (!sku || !skuToEbay.has(sku)) continue;
            const itemId = skuToEbay.get(sku);
            
            // Query eBay API
            const ebRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`, {
              headers: { "Authorization": `Bearer ${tokens.ebayToken}` }
            });
            
            if (ebRes.ok) {
               const ebItem = await ebRes.json();
               if (ebItem?.image?.imageUrl) {
                  ebayUrl = ebItem.image.imageUrl;
                  variantIdMatch = v.external_variant_id;
                  break;
               }
            } else {
               const errText = await ebRes.text();
               if (errText.includes("item group")) {
                  const grpRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemId}`, {
                     headers: { "Authorization": `Bearer ${tokens.ebayToken}` }
                  });
                  if (grpRes.ok) {
                     const grpData = await grpRes.json();
                     if (grpData.items?.[0]?.image?.imageUrl) {
                        ebayUrl = grpData.items[0].image.imageUrl;
                        variantIdMatch = v.external_variant_id;
                        break;
                     }
                  }
               }
            }
         }

         if (ebayUrl) {
            console.log(`Found eBay Image: ${ebayUrl}`);
            const base64Data = await downloadImageAsBase64(ebayUrl);
            
            const payload: any = { image: { attachment: base64Data } };
            if (variantIdMatch) payload.image.variant_ids = [parseInt(variantIdMatch)];

             const postRes = await fetch(`https://${shConn.shopDomain}/admin/api/2024-01/products/${shId}/images.json`, {
               method: "POST",
               headers: { "X-Shopify-Access-Token": shConn.accessToken, "Content-Type": "application/json" },
               body: JSON.stringify(payload)
             });
             if (postRes.ok) {
                const shImageData = await postRes.json();
                const newCdn = shImageData.image?.src;
                if (newCdn) {
                   await db.insert(productAssets).values({
                     productId, assetType: "image", url: newCdn, position: 0, isPrimary: 1, storageType: "url"
                   });
                   downloadedFromEbayCount++;
                }
             }
         } else {
            console.log(`No eBay image found for product ${productId}`);
         }
         await new Promise(r => setTimeout(r, 600));
         continue;
      }

      // Scenario 3: Shopify has images, Echelon is missing them (backfill failure?)
      if (assets.length === 0 && shImagesCount > 0) {
         console.log(`Product ${productId} missing in Echelon, pulling ${shImagesCount} images from Shopify...`);
         for (const img of shData.product.images) {
             await db.insert(productAssets).values({
                 productId, assetType: "image", url: img.src, position: img.position - 1, isPrimary: img.position === 1 ? 1 : 0, storageType: "url"
             });
         }
         skippedCount++; // Handled via backfill
         continue;
      }
      
      // Scenario 4: Both have images, all good.
      skippedCount++;

    } catch (e: any) {
      console.error(`Error on product ${data.shopifyId}:`, e.message);
    }
  }

  console.log(`\n=== Image Sync Complete ===`);
  console.log(`Images pushed from Echelon to Shopify: ${pushedFromEchelonCount}`);
  console.log(`Images downloaded from eBay & pushed: ${downloadedFromEbayCount}`);
  console.log(`Products skipped/healthy: ${skippedCount}`);
  process.exit(0);
}
run();
