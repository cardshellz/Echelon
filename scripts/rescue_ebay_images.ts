import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import "dotenv/config";
import { eq, inArray, and } from "drizzle-orm";
import { 
  channelConnections, 
  channels, 
  channelFeeds, 
  products, 
  productVariants, 
  productAssets 
} from "../shared/schema";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const db = drizzle(pool);

async function downloadImageAsBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download image from eBay CDN: ${resp.status} ${resp.statusText}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function getTokens() {
  const allConnections = await db
    .select({
      provider: channels.provider,
      shopDomain: channelConnections.shopDomain,
      accessToken: channelConnections.accessToken,
    })
    .from(channelConnections)
    .innerJoin(channels, eq(channels.id, channelConnections.channelId));

  const shopifyConn = allConnections.find(c => c.provider === "shopify");
  const ebayConn = allConnections.find(c => c.provider === "ebay");

  // Fallback to ebay_oauth if not found in channelConnections
  let ebayToken = ebayConn?.accessToken;
  if (!ebayToken) {
    const res = await pool.query("SELECT access_token FROM ebay_oauth_tokens ORDER BY id DESC LIMIT 1");
    if (res.rows.length > 0) ebayToken = res.rows[0].access_token;
  }

  return {
    shopify: shopifyConn,
    ebayToken,
  };
}

async function run() {
  console.log("Starting eBay Image Rescuer...");
  const tokens = await getTokens();

  if (!tokens.ebayToken) {
    console.error("No eBay Token found!");
    process.exit(1);
  }
  if (!tokens.shopify || !tokens.shopify.accessToken || !tokens.shopify.shopDomain) {
    console.error("No Shopify Credentials found!");
    process.exit(1);
  }

  // 1. Get all Shopify products that correspond to Echelon products
  const shopifyFeeds = await db
    .select({
      channelVariantId: channelFeeds.channelVariantId,
      channelProductId: channelFeeds.channelProductId,
      channelSku: channelFeeds.channelSku,
      productVariantId: channelFeeds.productVariantId,
      productId: productVariants.productId,
    })
    .from(channelFeeds)
    .innerJoin(productVariants, eq(productVariants.id, channelFeeds.productVariantId))
    .where(eq(channelFeeds.channelType, "shopify"));

  // Get eBay item IDs mapping
  const ebayFeeds = await db.execute(
    `SELECT cl.external_product_id as item_id, pv.sku 
     FROM channel_listings cl 
     JOIN channels c ON c.id = cl.channel_id 
     JOIN product_variants pv ON pv.id = cl.product_variant_id 
     WHERE c.provider = 'ebay' AND cl.external_product_id IS NOT NULL`
  );
  
  const skuToEbayItemId = new Map<string, string>();
  for (const row of ebayFeeds.rows) {
    if (row.sku && row.item_id) {
       skuToEbayItemId.set(row.sku as string, row.item_id as string);
    }
  }

  console.log(`Found ${shopifyFeeds.length} Shopify product feeds mapped in Echelon.`);

  // To avoid duplicates, we group by Shopify Product ID
  const productsToProcess = new Map<string, {
    shopifyProductId: string,
    echelonProductId: number,
    variants: typeof shopifyFeeds
  }>();

  for (const feed of shopifyFeeds) {
    if (!feed.channelProductId || !feed.channelSku) continue;
    
    if (!productsToProcess.has(feed.channelProductId)) {
      productsToProcess.set(feed.channelProductId, {
        shopifyProductId: feed.channelProductId,
        echelonProductId: feed.productId,
        variants: []
      });
    }
    productsToProcess.get(feed.channelProductId)!.variants.push(feed);
  }

  console.log(`Processing ${productsToProcess.size} unique Shopify Products.`);

  let successCount = 0;
  let errorCount = 0;
  
  for (const { shopifyProductId, echelonProductId, variants } of productsToProcess.values()) {
    try {
      console.log(`\n--- Processing Shopify Product ${shopifyProductId} ---`);
      
      // Check if product already has assets in Echelon
      const existingAssets = await db.select().from(productAssets).where(eq(productAssets.productId, echelonProductId));
      if (existingAssets.length > 0) {
        console.log(`Product already has ${existingAssets.length} assets mapped in Echelon. Skipping...`);
        continue;
      }

      // Collect all SKUs for this product to search eBay
      const skus = Array.from(new Set(variants.map(v => v.channelSku)));
      const retrievedImageUrls = new Set<string>();
      let ebayUrlToUpload: string | null = null;
      let targetVariantId: string | null = null;

      // Iterate through SKUs to find an eBay image
      for (const sku of skus) {
        if (!sku) continue;
        const itemId = skuToEbayItemId.get(sku);
        if (!itemId) {
           console.log(`No eBay Item ID mapped for SKU: ${sku}`);
           continue;
        }

        const res = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`, {
          headers: {
            "Authorization": `Bearer ${tokens.ebayToken}`
          }
        });
        
        if (res.ok) {
          const item = await res.json();
          const mainImageUrl = item?.image?.imageUrl;
          const allImages = mainImageUrl ? [mainImageUrl] : [];
          if (item?.additionalImages) {
             item.additionalImages.forEach((img: any) => { if (img.imageUrl) allImages.push(img.imageUrl); });
          }
          
          if (allImages.length > 0) {
            ebayUrlToUpload = allImages[0];
            targetVariantId = variants.find(v => v.channelSku === sku)?.channelVariantId || null;
            break; 
          }
        } else {
          const errText = await res.text();
          let parsedErr: any;
          try { parsedErr = JSON.parse(errText); } catch (e) {}

          const isItemGroup = parsedErr?.errors?.some((e: any) => e.message?.includes("item group"));
          
          if (isItemGroup) {
            console.log(`Item ${itemId} is a group. Fetching item group...`);
            const groupRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=${itemId}`, {
              headers: { "Authorization": `Bearer ${tokens.ebayToken}` }
            });
            if (groupRes.ok) {
               const groupData = await groupRes.json();
               const firstItem = groupData.items?.[0]; // Get images from the first child item
               const mainImageUrl = firstItem?.image?.imageUrl;
               const allImages = mainImageUrl ? [mainImageUrl] : [];
               if (firstItem?.additionalImages) {
                 firstItem.additionalImages.forEach((img: any) => { if (img.imageUrl) allImages.push(img.imageUrl); });
               }

               if (allImages.length > 0) {
                 ebayUrlToUpload = allImages[0];
                 targetVariantId = variants.find(v => v.channelSku === sku)?.channelVariantId || null;
                 break;
               }
            } else {
               console.error(`Group API Error for ${itemId}: ${groupRes.status} ${await groupRes.text()}`);
            }
          } else {
            console.error(`eBay API Error for ${sku} (Item ${itemId}): ${res.status} ${errText}`);
          }
        }
      }

      if (!ebayUrlToUpload) {
        console.log(`No images found on eBay for any SKUs: ${skus.join(", ")}`);
        continue;
      }

      console.log(`Found eBay Image: ${ebayUrlToUpload}. Downloading base64...`);
      const base64Data = await downloadImageAsBase64(ebayUrlToUpload);

      // Now push to Shopify
      console.log(`Pushing Base64 image to Shopify Product ${shopifyProductId}...`);
      const shStore = tokens.shopify.shopDomain;
      const shToken = tokens.shopify.accessToken;
      
      const payload: any = {
        image: {
          attachment: base64Data
        }
      };
      // Link the image to the specific variant if possible
      if (targetVariantId) {
         payload.image.variant_ids = [parseInt(targetVariantId)];
      }

      const postRes = await fetch(`https://${shStore}/admin/api/2024-01/products/${shopifyProductId}/images.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": shToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!postRes.ok) {
         const err = await postRes.text();
         throw new Error(`Shopify API Error: ${postRes.status} ${err}`);
      }

      const shopifyData = await postRes.json();
      const newCdnUrl = shopifyData.image?.src;
      
      if (newCdnUrl) {
        console.log(`Successfully uploaded! New Shopify CDN URL: ${newCdnUrl}`);
        // Backfill Echelon
        await db.insert(productAssets).values({
          productId: echelonProductId,
          productVariantId: null, // Product level image
          assetType: "image",
          url: newCdnUrl,
          position: 0,
          isPrimary: 1,
          storageType: "url"
        });
        console.log(`Saved new URL to Echelon product_assets.`);
        successCount++;
      }

      // Small delay to respect Shopify and eBay rate limits
      await new Promise(r => setTimeout(r, 600));

    } catch (err: any) {
      console.error(`Error processing product ${shopifyProductId}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\n=== Rescue Complete ===`);
  console.log(`Successfully pushed and mapped: ${successCount}`);
  console.log(`Errors encountered: ${errorCount}`);
  process.exit(0);
}

run().catch(err => {
  console.error("Rescue script crashed!", err);
  process.exit(1);
});
