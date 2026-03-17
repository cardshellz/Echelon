/**
 * eBay Account Reconnaissance
 * Pulls business policies, store info, existing listings, and categories
 */
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Get eBay token
  const tokenRes = await pool.query(
    "SELECT access_token, channel_id FROM ebay_oauth_tokens WHERE environment = 'production' ORDER BY updated_at DESC LIMIT 1"
  );
  if (tokenRes.rows.length === 0) throw new Error("No eBay tokens found");
  const { access_token: token, channel_id: channelId } = tokenRes.rows[0];
  console.log(`Using channel ${channelId}, token: ${token.substring(0, 20)}...\n`);

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  // 1. Get fulfillment policies
  console.log("=== FULFILLMENT (SHIPPING) POLICIES ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", { headers });
    const data = await resp.json();
    if (data.fulfillmentPolicies) {
      for (const p of data.fulfillmentPolicies) {
        console.log(`  ID: ${p.fulfillmentPolicyId} | Name: ${p.name} | Domestic: ${p.shippingOptions?.[0]?.optionType}`);
      }
    } else {
      console.log("  Response:", JSON.stringify(data));
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 2. Get payment policies
  console.log("\n=== PAYMENT POLICIES ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US", { headers });
    const data = await resp.json();
    if (data.paymentPolicies) {
      for (const p of data.paymentPolicies) {
        console.log(`  ID: ${p.paymentPolicyId} | Name: ${p.name} | Managed: ${p.paymentMethods?.some((m: any) => m.paymentMethodType === 'PERSONAL_CHECK') ? 'No' : 'Yes'}`);
      }
    } else {
      console.log("  Response:", JSON.stringify(data));
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 3. Get return policies
  console.log("\n=== RETURN POLICIES ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US", { headers });
    const data = await resp.json();
    if (data.returnPolicies) {
      for (const p of data.returnPolicies) {
        console.log(`  ID: ${p.returnPolicyId} | Name: ${p.name} | Returns: ${p.returnsAccepted} | Period: ${p.returnPeriod?.value} ${p.returnPeriod?.unit}`);
      }
    } else {
      console.log("  Response:", JSON.stringify(data));
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 4. Get inventory locations (merchant locations)
  console.log("\n=== INVENTORY LOCATIONS ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/inventory/v1/location?limit=25", { headers });
    const data = await resp.json();
    if (data.locations && data.locations.length > 0) {
      for (const loc of data.locations) {
        console.log(`  Key: ${loc.merchantLocationKey} | Name: ${loc.name} | Status: ${loc.merchantLocationStatus}`);
        if (loc.location?.address) {
          const a = loc.location.address;
          console.log(`    Address: ${a.addressLine1}, ${a.city}, ${a.stateOrProvince} ${a.postalCode}`);
        }
      }
    } else {
      console.log("  No locations found. Response:", JSON.stringify(data));
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 5. Get active listings count
  console.log("\n=== ACTIVE LISTINGS ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/inventory/v1/inventory_item?limit=5", { headers });
    const data = await resp.json();
    console.log(`  Total inventory items: ${data.total || 0}`);
    if (data.inventoryItems) {
      for (const item of data.inventoryItems.slice(0, 5)) {
        console.log(`  SKU: ${item.sku} | Title: ${item.product?.title?.substring(0, 60)}`);
      }
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 6. Get active offers
  console.log("\n=== ACTIVE OFFERS (first 5) ===");
  try {
    const resp = await fetch("https://api.ebay.com/sell/inventory/v1/offer?limit=5&marketplace_id=EBAY_US", { headers });
    const data = await resp.json();
    console.log(`  Total offers: ${data.total || 0}`);
    if (data.offers) {
      for (const o of data.offers.slice(0, 5)) {
        console.log(`  SKU: ${o.sku} | Listing: ${o.listingId} | Status: ${o.status} | Price: ${o.pricingSummary?.price?.value} ${o.pricingSummary?.price?.currency}`);
      }
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 7. Get seller info
  console.log("\n=== STORE / ACCOUNT INFO ===");
  try {
    // Try getting recent orders to verify account works
    const resp = await fetch("https://api.ebay.com/sell/fulfillment/v1/order?limit=3&orderBy=creationdate%20desc", { headers });
    const data = await resp.json();
    console.log(`  Recent orders: ${data.total || 0} total`);
    if (data.orders) {
      for (const o of data.orders.slice(0, 3)) {
        console.log(`  Order: ${o.orderId} | Total: ${o.pricingSummary?.total?.value} | Status: ${o.orderFulfillmentStatus} | Date: ${o.creationDate}`);
      }
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  // 8. Check for trading card supplies categories
  console.log("\n=== RELEVANT CATEGORIES ===");
  try {
    const resp = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=toploader+trading+card", { headers });
    const data = await resp.json();
    if (data.categorySuggestions) {
      for (const s of data.categorySuggestions.slice(0, 5)) {
        const path = s.categoryTreeNodeAncestors?.map((a: any) => a.categoryName).reverse().join(" > ") || "";
        console.log(`  ${s.category.categoryId}: ${s.category.categoryName} (${path})`);
      }
    }
  } catch (e: any) { console.log("  Error:", e.message); }

  await pool.end();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
