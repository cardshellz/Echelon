/**
 * Backfill: enqueue the `cardshellz.shipping_group` product metafield for every
 * Echelon product already synced to Shopify (shopify_product_id IS NOT NULL).
 *
 * Run once after deploying the shipping-group → Shopify sync, and any time you
 * want to reconcile (it's the safety net for the instant per-write enqueue in
 * catalog.routes.ts). Idempotent — the club app's outbox dedupes pending rows.
 *
 * Usage: npx tsx scripts/backfill-shipping-group-metafields.ts
 *   (Heroku: heroku run npx tsx scripts/backfill-shipping-group-metafields.ts -a cardshellz-echelon)
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { enqueueShippingGroupMetafields } from "../server/modules/catalog/shipping-group-sync";

async function main() {
  const res = await db.execute(
    sql`SELECT id FROM catalog.products WHERE shopify_product_id IS NOT NULL ORDER BY id`,
  );
  const ids = (res.rows as Array<{ id: number | string }>).map((r) => Number(r.id));
  console.log(`[backfill] enqueuing cardshellz.shipping_group for ${ids.length} product(s)...`);
  await enqueueShippingGroupMetafields(ids);
  console.log("[backfill] done — the shellz-club-app outbox worker will drain these to Shopify.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
