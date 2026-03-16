/**
 * Dry Run Sync Script
 *
 * Runs the full sync orchestrator in DRY_RUN mode to preview what
 * Echelon would push to Shopify without making any external API calls.
 *
 * Usage: npx tsx scripts/run-dry-sync.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createInventoryAtpService } from "../server/modules/inventory/atp.service";
import { createAllocationEngine } from "../server/modules/channels/allocation-engine.service";
import { createSourceLockService } from "../server/modules/channels/source-lock.service";
import { createShopifyAdapter } from "../server/modules/channels/adapters/shopify.adapter";
import { ChannelAdapterRegistry } from "../server/modules/channels/channel-adapter.interface";
import { createChannelProductPushService } from "../server/modules/channels/product-push.service";
import { createEchelonSyncOrchestrator } from "../server/modules/channels/echelon-sync-orchestrator.service";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool) as any;

  // Wire up all services
  const atpService = createInventoryAtpService(db);
  const allocationEngine = createAllocationEngine(db, atpService);
  const sourceLockService = createSourceLockService(db);
  const shopifyAdapter = createShopifyAdapter(db);
  const productPushService = createChannelProductPushService(db);

  const adapterRegistry = new ChannelAdapterRegistry();
  adapterRegistry.register(shopifyAdapter);

  const orchestrator = createEchelonSyncOrchestrator(
    db,
    allocationEngine,
    sourceLockService,
    adapterRegistry,
    productPushService,
  );

  console.log("=== ECHELON SYNC — DRY RUN ===");
  console.log("No external API calls will be made.\n");

  const result = await orchestrator.runFullSync({ dryRun: true });

  // Print inventory results
  console.log("\n=== INVENTORY SYNC PREVIEW ===");
  for (const inv of result.inventory) {
    console.log(`\nChannel: ${inv.channelName} (ID: ${inv.channelId})`);
    console.log(`  Variants to push: ${inv.variantsPushed}`);
    console.log(`  Variants skipped: ${inv.variantsSkipped}`);
    console.log(`  Errors: ${inv.variantsErrored}`);

    if (inv.details && inv.details.length > 0) {
      // Show top 20 by ATP
      const sorted = [...inv.details]
        .filter(d => d.action !== "skip")
        .sort((a, b) => (b.allocatedQty ?? 0) - (a.allocatedQty ?? 0));

      console.log(`\n  Top changes:`);
      console.log(`  ${"SKU".padEnd(35)} ${"ATP".padStart(6)} ${"Action".padStart(8)}`);
      console.log(`  ${"---".padEnd(35)} ${"---".padStart(6)} ${"------".padStart(8)}`);
      for (const d of sorted.slice(0, 30)) {
        console.log(`  ${(d.sku || "?").padEnd(35)} ${String(d.allocatedQty ?? 0).padStart(6)} ${(d.action || "push").padStart(8)}`);
      }
      if (sorted.length > 30) {
        console.log(`  ... and ${sorted.length - 30} more`);
      }
    }
  }

  // Print pricing results
  console.log("\n=== PRICING SYNC PREVIEW ===");
  for (const pr of result.pricing) {
    console.log(`\nChannel: ${pr.channelName} (ID: ${pr.channelId})`);
    console.log(`  Variants to push: ${pr.variantsPushed}`);
    console.log(`  Variants skipped: ${pr.variantsSkipped}`);
    console.log(`  Errors: ${pr.variantsErrored}`);

    if (pr.details && pr.details.length > 0) {
      const changes = pr.details.filter((d: any) => d.action !== "skip");
      if (changes.length > 0) {
        console.log(`\n  Price changes:`);
        console.log(`  ${"SKU".padEnd(35)} ${"Current".padStart(10)} ${"New".padStart(10)} ${"Action".padStart(8)}`);
        console.log(`  ${"---".padEnd(35)} ${"-------".padStart(10)} ${"---".padStart(10)} ${"------".padStart(8)}`);
        for (const d of changes.slice(0, 30)) {
          const current = d.currentPrice ? `$${(d.currentPrice / 100).toFixed(2)}` : "N/A";
          const newPrice = d.newPrice ? `$${(d.newPrice / 100).toFixed(2)}` : "N/A";
          console.log(`  ${(d.sku || "?").padEnd(35)} ${current.padStart(10)} ${newPrice.padStart(10)} ${(d.action || "push").padStart(8)}`);
        }
      }
    }
  }

  // Print listings results
  console.log("\n=== LISTINGS SYNC PREVIEW ===");
  for (const ls of result.listings) {
    console.log(`\nChannel: ${ls.channelName} (ID: ${ls.channelId})`);
    console.log(`  Products to push: ${ls.productsPushed}`);
    console.log(`  Skipped: ${ls.productsSkipped}`);
    console.log(`  Errors: ${ls.productsErrored}`);
  }

  // Errors
  if (result.errors.length > 0) {
    console.log("\n=== ERRORS ===");
    for (const err of result.errors) {
      console.log(`  ❌ ${err}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Mode: DRY RUN`);
  console.log(`Duration: ${(result.completedAt.getTime() - result.startedAt.getTime()) / 1000}s`);
  console.log(`Inventory channels: ${result.inventory.length}`);
  console.log(`Pricing channels: ${result.pricing.length}`);
  console.log(`Listing channels: ${result.listings.length}`);
  console.log(`Errors: ${result.errors.length}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
