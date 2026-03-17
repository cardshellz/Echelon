/**
 * Quick live sync for Shopify-Canada only
 * Uses the updated orchestrator that reads per-channel inventory item IDs
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
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool) as any;

  const atpService = createInventoryAtpService(db);
  const allocationEngine = createAllocationEngine(db, atpService);
  const sourceLockService = createSourceLockService(db);
  const shopifyAdapter = createShopifyAdapter(db);
  const productPushService = createChannelProductPushService(db);
  const adapterRegistry = new ChannelAdapterRegistry();
  adapterRegistry.register(shopifyAdapter);

  const orchestrator = createEchelonSyncOrchestrator(
    db, allocationEngine, sourceLockService, adapterRegistry, productPushService,
  );

  console.log("=== ECHELON LIVE SYNC — SHOPIFY-CANADA ONLY ===\n");

  // Only sync products that have CA inventory (product IDs for ESS-TOP and EG-SLV)
  // Use the full sync but we only care about CA results
  const result = await orchestrator.runFullSync({ dryRun: false });

  for (const inv of result.inventory) {
    if (inv.channelName?.includes("Canada")) {
      console.log(`\n${inv.channelName}:`);
      console.log(`  Pushed: ${inv.variantsPushed}, Skipped: ${inv.variantsSkipped}, Errors: ${inv.variantsErrored}`);
      if (inv.details) {
        const pushed = inv.details.filter((d: any) => d.status === "success");
        const errors = inv.details.filter((d: any) => d.status === "error");
        if (pushed.length > 0) {
          console.log(`  Successful pushes:`);
          for (const p of pushed) console.log(`    ✅ ${p.sku}: ${p.allocatedQty} units`);
        }
        if (errors.length > 0) {
          console.log(`  Errors:`);
          for (const e of errors) console.log(`    ❌ ${e.sku}: ${e.error}`);
        }
      }
    }
  }

  await pool.end();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
