/**
 * Live Full Sync — All Channels
 * Pushes inventory to ALL active channels. This is the real deal.
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

  console.log("=== ECHELON LIVE SYNC — ALL CHANNELS ===");
  console.log("⚡ Pushing inventory to Shopify US + Shopify CA\n");

  const result = await orchestrator.runFullSync({ dryRun: false });

  for (const inv of result.inventory) {
    console.log(`\n${inv.channelName}:`);
    console.log(`  Pushed: ${inv.variantsPushed}, Skipped: ${inv.variantsSkipped}, Errors: ${inv.variantsErrored}`);

    if (inv.details) {
      const errors = inv.details.filter((d: any) => d.status === "error");
      if (errors.length > 0) {
        console.log(`  First 5 errors:`);
        for (const e of errors.slice(0, 5)) {
          console.log(`    ✗ ${e.sku}: ${e.error}`);
        }
      }
    }
  }

  console.log(`\nDuration: ${((result.completedAt.getTime() - result.startedAt.getTime()) / 1000).toFixed(1)}s`);
  console.log(`Total errors: ${result.errors.length}`);
  if (result.errors.length > 0) result.errors.forEach((e: string) => console.log(`  ❌ ${e}`));

  await pool.end();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
