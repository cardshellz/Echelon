/**
 * Live Inventory Sync — Single Channel
 *
 * Runs the full allocation engine but only pushes inventory to the target channel.
 * Other channels run in dry-run mode.
 *
 * Usage: CHANNEL_ID=37 npx tsx scripts/run-live-inventory-sync.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import { createInventoryAtpService } from "../server/modules/inventory/atp.service";
import { createAllocationEngine } from "../server/modules/channels/allocation-engine.service";
import { createSourceLockService } from "../server/modules/channels/source-lock.service";
import { createShopifyAdapter } from "../server/modules/channels/adapters/shopify.adapter";
import { ChannelAdapterRegistry } from "../server/modules/channels/channel-adapter.interface";
import { createChannelProductPushService } from "../server/modules/channels/product-push.service";
import { createEchelonSyncOrchestrator } from "../server/modules/channels/echelon-sync-orchestrator.service";
import { channels } from "../shared/schema";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const targetChannelId = parseInt(process.env.CHANNEL_ID || "0");

  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  if (!targetChannelId) {
    console.error("CHANNEL_ID not set. Usage: CHANNEL_ID=37 npx tsx scripts/run-live-inventory-sync.ts");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool) as any;

  // Verify channel
  const [channel] = await db.select().from(channels).where(eq(channels.id, targetChannelId));
  if (!channel) {
    console.error(`Channel ${targetChannelId} not found`);
    process.exit(1);
  }

  console.log(`=== LIVE INVENTORY SYNC — SINGLE CHANNEL ===`);
  console.log(`Target: ${channel.name} (ID: ${channel.id})`);
  console.log(`⚠️  Only ${channel.name} will receive LIVE pushes.`);
  console.log(`    All other channels will be DRY RUN.\n`);

  // Wire up services
  const atpService = createInventoryAtpService(db);
  const allocationEngine = createAllocationEngine(db, atpService);
  const sourceLockService = createSourceLockService(db);
  const realAdapter = createShopifyAdapter(db);
  const productPushService = createChannelProductPushService(db);

  // Create a channel-gating proxy: only pushes to target channel, blocks all others
  const gatedAdapter = Object.create(realAdapter);
  const originalPushInventory = realAdapter.pushInventory.bind(realAdapter);
  gatedAdapter.pushInventory = async function(channelId: number, items: any[]): Promise<any[]> {
    if (channelId === targetChannelId) {
      return originalPushInventory(channelId, items);
    }
    // Fake success for other channels — no Shopify API calls
    return items.map((item: any) => ({
      variantId: item.variantId,
      pushedQty: item.allocatedQty,
      status: "success",
    }));
  };

  const adapterRegistry = new ChannelAdapterRegistry();
  adapterRegistry.register(gatedAdapter);

  const orchestrator = createEchelonSyncOrchestrator(
    db,
    allocationEngine,
    sourceLockService,
    adapterRegistry,
    productPushService,
  );

  const startedAt = Date.now();

  // Run inventory sync — LIVE for target, gated for others
  const inventoryResults = await orchestrator.syncInventoryForAllProducts(
    { dryRun: false },
    "manual_live_sync",
  );

  // Report
  for (const r of inventoryResults) {
    const isTarget = r.channelId === targetChannelId;
    console.log(`\n${isTarget ? "🟢 LIVE" : "⚪ GATED"} — ${r.channelName}:`);
    console.log(`  Pushed: ${r.variantsPushed}, Skipped: ${r.variantsSkipped}, Errors: ${r.variantsErrored}`);

    if (isTarget && r.details) {
      const pushed = r.details.filter((d: any) => d.status === "success");
      const errored = r.details.filter((d: any) => d.status === "error");

      if (pushed.length > 0) {
        console.log(`\n  Top pushes:`);
        const sorted = pushed.sort((a: any, b: any) => (b.allocatedQty ?? 0) - (a.allocatedQty ?? 0));
        for (const d of sorted.slice(0, 20)) {
          console.log(`    ✓ ${(d.sku || "?").padEnd(35)} → ${d.allocatedQty} units`);
        }
        if (sorted.length > 20) console.log(`    ... and ${sorted.length - 20} more`);
      }

      if (errored.length > 0) {
        console.log(`\n  ❌ Errors:`);
        for (const e of errored) {
          console.log(`    ${e.sku}: ${e.error}`);
        }
      }
    }
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nTotal duration: ${duration}s`);

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
