/**
 * Phase 1 — Historical ledger backfill.
 *
 * Reads the variance report from the Phase 0 reconciler (replay vs. live levels)
 * and writes one corrective `adjustment` ledger row per drifted cell to bring the
 * ledger into agreement with the physical truth (inventory_levels).
 *
 * This is a ONE-TIME operation. It should only be run AFTER all write-path leaks
 * are sealed (C4, M5, M6) so that new drift doesn't reappear after the backfill.
 *
 * Every corrective row is tagged with:
 *   - transaction_type = 'adjustment'
 *   - reference_type   = 'reconciliation'
 *   - batch_id         = 'phase1-backfill-YYYYMMDD'
 *   - notes            = human-readable explanation of the correction
 *
 * Usage:
 *   npx tsx scripts/backfill-ledger-variances.ts --dry-run    # preview, no writes
 *   npx tsx scripts/backfill-ledger-variances.ts --apply      # actually write
 *
 * Safety:
 *   - Requires explicit --apply flag to write; default is dry-run.
 *   - Every INSERT is idempotent via the batch_id — re-running after a partial
 *     failure is safe (duplicate batch+variant+location rows are detectable).
 *   - Does NOT touch inventory_levels — only writes ledger rows to explain
 *     the existing reality.
 */

import pg from "pg";
import {
  replayLedger,
  reconcile,
  type LedgerRow,
  type LevelRow,
} from "../server/modules/inventory/reconcile/ledger-replay";

const { Pool } = pg;

interface CliOptions {
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") opts.apply = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(2);
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const batchId = `phase1-backfill-${new Date().toISOString().slice(0, 10)}`;

  try {
    // 1. Replay the ledger (same as the reconciler).
    const ledgerRes = await pool.query(
      `SELECT transaction_type   AS "transactionType",
              variant_qty_delta  AS "variantQtyDelta",
              product_variant_id AS "productVariantId",
              from_location_id   AS "fromLocationId",
              to_location_id     AS "toLocationId"
         FROM inventory.inventory_transactions
         WHERE voided_at IS NULL
         ORDER BY id ASC`,
    );

    const ledgerRows: LedgerRow[] = ledgerRes.rows.map((r) => ({
      transactionType: String(r.transactionType),
      variantQtyDelta: Number(r.variantQtyDelta),
      productVariantId: r.productVariantId == null ? null : Number(r.productVariantId),
      fromLocationId: r.fromLocationId == null ? null : Number(r.fromLocationId),
      toLocationId: r.toLocationId == null ? null : Number(r.toLocationId),
    }));

    const expected = replayLedger(ledgerRows);

    // 2. Load actual levels.
    const levelsRes = await pool.query(
      `SELECT product_variant_id    AS "productVariantId",
              warehouse_location_id AS "warehouseLocationId",
              variant_qty           AS "variantQty"
         FROM inventory.inventory_levels
         WHERE 1=1`,
    );

    const levels: LevelRow[] = levelsRes.rows.map((r) => ({
      productVariantId: Number(r.productVariantId),
      warehouseLocationId: Number(r.warehouseLocationId),
      variantQty: Number(r.variantQty),
    }));

    // 3. Reconcile to find variances.
    const result = reconcile(expected, levels);

    console.log("");
    console.log(`=== Phase 1 Ledger Backfill ${opts.apply ? "(APPLYING)" : "(DRY RUN)"} ===`);
    console.log(`Batch ID:     ${batchId}`);
    console.log(`Variances:    ${result.variances.length}`);
    console.log(`Total drift:  ${result.totalAbsDrift} variant-units`);
    console.log("");

    if (result.variances.length === 0) {
      console.log("Zero variance — nothing to backfill.");
      process.exitCode = 0;
      return;
    }

    if (!opts.apply) {
      console.log("DRY RUN — would write the following corrective adjustments:");
      console.log("");
      console.log("  variant   location   ledger-expected   actual   correction-delta");
      console.log("  -------   --------   ---------------   ------   ----------------");
      for (const v of result.variances) {
        const delta = v.diff; // actual - expected = what we need to add to the ledger
        console.log(
          `  ${String(v.productVariantId).padStart(7)}   ` +
            `${String(v.warehouseLocationId).padStart(8)}   ` +
            `${String(v.expected).padStart(15)}   ` +
            `${String(v.actual).padStart(6)}   ` +
            `${(delta > 0 ? "+" : "") + delta}`.padStart(16),
        );
      }
      console.log("");
      console.log(`Run with --apply to write ${result.variances.length} corrective ledger rows.`);
      process.exitCode = 0;
      return;
    }

    // 4. Write corrective adjustments — one per variance, all in one transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let written = 0;
      for (const v of result.variances) {
        const delta = v.diff; // actual - expected
        if (delta === 0) continue;

        await client.query(
          `INSERT INTO inventory.inventory_transactions
            (product_variant_id, from_location_id, to_location_id,
             transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after,
             source_state, target_state,
             batch_id, reference_type, reference_id,
             notes, is_implicit, user_id, created_at)
           VALUES ($1, $2, $3,
             'adjustment', $4,
             $5, $6,
             'on_hand', 'on_hand',
             $7, 'reconciliation', $8,
             $9, 1, 'system', NOW())`,
          [
            v.productVariantId,
            delta < 0 ? v.warehouseLocationId : null,  // from (outbound)
            delta > 0 ? v.warehouseLocationId : null,  // to (inbound)
            delta,
            v.expected,  // qty_before = what ledger thought
            v.actual,    // qty_after = what's actually there
            batchId,
            `${v.productVariantId}:${v.warehouseLocationId}`,
            `Phase 1 reconciliation: ledger expected ${v.expected}, actual ${v.actual} (correction ${delta > 0 ? "+" : ""}${delta}). Batch ${batchId}.`,
          ],
        );
        written++;
      }

      await client.query("COMMIT");
      console.log(`Wrote ${written} corrective ledger rows (batch: ${batchId}).`);
      console.log("");
      console.log("Re-run the reconciler to verify zero variance:");
      console.log("  npx tsx scripts/reconcile-inventory-ledger.ts");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    process.exitCode = 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(2);
});
