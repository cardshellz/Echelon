/**
 * Standalone script to run catalog backfill.
 * Usage: DATABASE_URL=... npx tsx scripts/run-backfill.ts [--dry-run] [--channel-id=36]
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createCatalogBackfillService } from "../server/modules/channels/catalog-backfill.service";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const channelIdArg = args.find(a => a.startsWith("--channel-id="));
const channelId = channelIdArg ? parseInt(channelIdArg.split("=")[1], 10) : 36;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  const db = drizzle(pool) as any;
  const service = createCatalogBackfillService(db);

  console.log(`\n=== Catalog Backfill ===`);
  console.log(`Mode: ${isDryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`========================\n`);

  try {
    const result = await service.run({
      channelId,
      dryRun: isDryRun,
      backfillPricing: true,
      backfillAssets: true,
      backfillInventory: true,
    });

    console.log("\n=== BACKFILL RESULTS ===");
    console.log(`Products: ${result.products.created} created, ${result.products.updated} updated, ${result.products.skipped} skipped, ${result.products.failed} failed (${result.products.total} total)`);
    console.log(`Variants: ${result.variants.created} created, ${result.variants.updated} updated, ${result.variants.skipped} skipped, ${result.variants.failed} failed (${result.variants.total} total)`);
    
    if (result.inventory) {
      console.log(`Inventory: ${result.inventory.imported} imported, ${result.inventory.skipped} skipped (had Echelon data), ${result.inventory.noShopifyData} no Shopify data`);
    }

    if (result.reconciliation && result.reconciliation.length > 0) {
      console.log(`\n=== INVENTORY RECONCILIATION ===`);
      console.log(`SKU | Echelon | Shopify | Delta`);
      console.log(`----|---------|---------|------`);
      for (const r of result.reconciliation) {
        const delta = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
        console.log(`${r.sku} | ${r.echelonQty} | ${r.shopifyQty} | ${delta}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`\n=== ERRORS ===`);
      result.errors.forEach(e => console.error(`  - ${e}`));
    }

    console.log("\nBackfill complete.");
  } catch (err: any) {
    console.error("Backfill failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
