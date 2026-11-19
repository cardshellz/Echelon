/**
 * Backfill: queue the `cardshellz.units_per_variant` and `cardshellz.pack_type`
 * variant metafields for every Shopify variant linked from
 * catalog.product_variants.
 *
 * The migration `*_variant_pack_shopify_metafields.sql` queues them on every
 * change from then on; run this once after it is deployed, and any time you
 * want to reconcile. It calls the same database function the triggers call, so
 * the values are exactly what a change would queue. Idempotent: the club app's
 * outbox keeps one pending row per variant and key.
 *
 * Usage:
 *   npx tsx scripts/backfill-variant-pack-metafields.ts --dry-run   (queues, reports, rolls back)
 *   npx tsx scripts/backfill-variant-pack-metafields.ts
 *   (Heroku: heroku run npx tsx scripts/backfill-variant-pack-metafields.ts -a cardshellz-echelon)
 *
 * The shellz-club-app outbox worker writes the rows to Shopify (about once a
 * minute). Shopify variants that no longer exist come back as "Owner does not
 * exist"; the worker records them and later runs skip them.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

class DryRunRollback extends Error {
  constructor() {
    super("dry run: rolled back");
    this.name = "DryRunRollback";
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const installed = await db.execute(
    sql`SELECT to_regprocedure('catalog.enqueue_variant_pack_metafields(text)') IS NOT NULL AS installed`,
  );
  if (!(installed.rows[0] as { installed: boolean }).installed) {
    throw new Error("catalog.enqueue_variant_pack_metafields(text) is missing: deploy the migration first");
  }

  try {
    await db.transaction(async (tx) => {
      const linked = await tx.execute(sql`
        SELECT DISTINCT shopify_variant_id
        FROM catalog.product_variants
        WHERE shopify_variant_id IS NOT NULL
        ORDER BY shopify_variant_id
      `);
      const ids = (linked.rows as Array<{ shopify_variant_id: string }>).map((row) => row.shopify_variant_id);
      console.log(`[backfill] ${ids.length} linked Shopify variant(s)`);

      let queued = 0;
      let skipped = 0;
      for (const id of ids) {
        const result = await tx.execute(sql`SELECT catalog.enqueue_variant_pack_metafields(${id}) AS queued`);
        if (Number((result.rows[0] as { queued: number | string }).queued) > 0) queued += 1;
        else skipped += 1;
      }

      const summary = await tx.execute(sql`
        SELECT key, operation, value::text AS value, count(*)::int AS rows
        FROM membership.shopify_metafield_outbox
        WHERE status = 'pending'
          AND target_type = 'productvariant'
          AND namespace = 'cardshellz'
          AND key IN ('units_per_variant', 'pack_type')
        GROUP BY key, operation, value::text
        ORDER BY key, rows DESC
      `);
      console.log(`[backfill] queued ${queued} variant(s); ${skipped} skipped (malformed id, known-deleted in Shopify, or no outbox)`);
      for (const row of summary.rows as Array<{ key: string; operation: string; value: string | null; rows: number }>) {
        console.log(`  ${row.key.padEnd(18)} ${row.operation.padEnd(6)} ${String(row.value ?? "").padEnd(8)} ${row.rows}`);
      }

      if (dryRun) throw new DryRunRollback();
    });
    console.log("[backfill] done: the shellz-club-app outbox worker will write these to Shopify.");
  } catch (error) {
    if (error instanceof DryRunRollback) {
      console.log("[backfill] dry run: nothing was queued (rolled back).");
    } else {
      throw error;
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
