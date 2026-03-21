/**
 * One-time cleanup: Delete the old PROD-60 eBay inventory group and items.
 * 
 * The HERO Diamond Shell was originally pushed with group key `PROD-60` instead
 * of `HERO-GRD-PSA`. eBay group keys are immutable, so we need to delete everything
 * and re-push with the correct key.
 * 
 * Usage: npx tsx scripts/cleanup-prod60.ts
 */

import https from "https";
import { db, pool } from "../server/db";
import { eq, and } from "drizzle-orm";
import { channelConnections, ebayOauthTokens } from "@shared/schema";
import {
  EbayAuthService,
  createEbayAuthConfig,
} from "../server/modules/channels/adapters/ebay/ebay-auth.service";

const EBAY_CHANNEL_ID = 67;
const PRODUCT_ID = 60;

function ebayApiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname =
    environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 204) {
          resolve({ status: 204 });
          return;
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : { status: res.statusCode });
          } catch {
            resolve(data);
          }
          return;
        }
        // For 404s during cleanup, that's fine - already deleted
        if (res.statusCode === 404) {
          console.log(`  → 404 Not Found (already deleted): ${method} ${path}`);
          resolve({ status: 404, notFound: true });
          return;
        }
        reject(
          new Error(
            `eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 1000)}`,
          ),
        );
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log("=== PROD-60 Cleanup Script ===\n");

  // Get access token
  const config = createEbayAuthConfig();
  const authService = new EbayAuthService(db as any, config);
  const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
  console.log("✓ Got eBay access token\n");

  // Step 1: Delete offers for the SKUs
  const skus = ["HERO-GRD-PSA-P1", "HERO-GRD-PSA-B5", "HERO-GRD-PSA-C50"];

  // First, find and delete any offers associated with these SKUs
  for (const sku of skus) {
    console.log(`Checking offers for SKU: ${sku}...`);
    try {
      const offers = await ebayApiRequest(
        "GET",
        `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=100`,
        accessToken,
      );
      if (offers?.offers && offers.offers.length > 0) {
        for (const offer of offers.offers) {
          console.log(`  Deleting offer ${offer.offerId}...`);
          try {
            await ebayApiRequest(
              "DELETE",
              `/sell/inventory/v1/offer/${offer.offerId}`,
              accessToken,
            );
            console.log(`  ✓ Deleted offer ${offer.offerId}`);
          } catch (err: any) {
            console.log(`  ⚠ Failed to delete offer ${offer.offerId}: ${err.message}`);
          }
        }
      } else {
        console.log(`  No offers found for ${sku}`);
      }
    } catch (err: any) {
      console.log(`  ⚠ Error fetching offers for ${sku}: ${err.message}`);
    }
  }

  // Step 2: Delete the inventory item group PROD-60
  console.log("\nDeleting inventory item group PROD-60...");
  try {
    await ebayApiRequest(
      "DELETE",
      `/sell/inventory/v1/inventory_item_group/PROD-60`,
      accessToken,
    );
    console.log("✓ Deleted inventory item group PROD-60");
  } catch (err: any) {
    console.log(`⚠ Failed to delete group PROD-60: ${err.message}`);
  }

  // Step 3: Delete individual inventory items
  for (const sku of skus) {
    console.log(`Deleting inventory item: ${sku}...`);
    try {
      await ebayApiRequest(
        "DELETE",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        accessToken,
      );
      console.log(`✓ Deleted inventory item ${sku}`);
    } catch (err: any) {
      console.log(`⚠ Failed to delete inventory item ${sku}: ${err.message}`);
    }
  }

  // Step 4: Clean up channel_listings rows for channel 67, product 60
  console.log("\nCleaning up channel_listings rows...");
  const client = await pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM channel_listings
       WHERE channel_id = $1
         AND product_variant_id IN (
           SELECT id FROM product_variants WHERE product_id = $2
         )
       RETURNING id, product_variant_id, external_sku`,
      [EBAY_CHANNEL_ID, PRODUCT_ID],
    );
    console.log(`✓ Deleted ${result.rowCount} channel_listings rows:`);
    for (const row of result.rows) {
      console.log(`  - listing ${row.id}: variant ${row.product_variant_id} (${row.external_sku})`);
    }
  } finally {
    client.release();
  }

  console.log("\n=== Cleanup complete! ===");
  console.log("You can now re-push product 60 with the correct group key HERO-GRD-PSA.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
