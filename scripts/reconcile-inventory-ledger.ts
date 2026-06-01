/**
 * Phase 0 — Inventory ledger reconciler (READ-ONLY).
 *
 * Replays inventory.inventory_transactions to reconstruct expected on-hand per
 * (variant, location) and diffs it against inventory.inventory_levels. Prints a
 * variance report. Makes NO writes.
 *
 * This is the instrument that quantifies WMS inventory trust (see
 * WMS-INVENTORY-REFACTOR.md §0 / Phase 0). Expect non-zero variance on first
 * run — known unledgered write paths (finding C4) guarantee drift; this report
 * is the baseline we drive to zero through Phases 1+.
 *
 * Usage:
 *   npx tsx scripts/reconcile-inventory-ledger.ts
 *   npx tsx scripts/reconcile-inventory-ledger.ts --json
 *   npx tsx scripts/reconcile-inventory-ledger.ts --limit=50      # top N variances
 *   npx tsx scripts/reconcile-inventory-ledger.ts --variant=1234  # one variant only
 *
 * Connection: uses EXTERNAL_DATABASE_URL (per CLAUDE.md), falling back to
 * DATABASE_URL.
 *
 * Exit code: 0 if zero variance, 1 if any variance found (so it can gate CI).
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
  json: boolean;
  limit: number | null;
  variantId: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { json: false, limit: null, variantId: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.split("=")[1]) || null;
    else if (arg.startsWith("--variant=")) opts.variantId = Number(arg.split("=")[1]) || null;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const connectionString =
    process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("ERROR: EXTERNAL_DATABASE_URL (or DATABASE_URL) is not set.");
    process.exit(2);
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const variantFilter = opts.variantId
      ? `WHERE product_variant_id = ${opts.variantId}`
      : "";

    // 1. Stream the ledger and replay it. We pull only the columns replay needs.
    //    Ordered by id for determinism; replay itself is order-independent for
    //    on-hand (pure sum) but ordering keeps any future debugging sane.
    const ledgerRes = await pool.query(
      `SELECT transaction_type   AS "transactionType",
              variant_qty_delta  AS "variantQtyDelta",
              product_variant_id AS "productVariantId",
              from_location_id   AS "fromLocationId",
              to_location_id     AS "toLocationId"
         FROM inventory.inventory_transactions
         ${variantFilter}
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
         ${variantFilter}`,
    );

    const levels: LevelRow[] = levelsRes.rows.map((r) => ({
      productVariantId: Number(r.productVariantId),
      warehouseLocationId: Number(r.warehouseLocationId),
      variantQty: Number(r.variantQty),
    }));

    // 3. Reconcile.
    const result = reconcile(expected, levels);

    const limited =
      opts.limit != null ? result.variances.slice(0, opts.limit) : result.variances;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ledgerRows: ledgerRows.length,
            cellsChecked: result.cellsChecked,
            varianceCount: result.variances.length,
            totalAbsDrift: result.totalAbsDrift,
            variances: limited,
          },
          null,
          2,
        ),
      );
    } else {
      console.log("");
      console.log("=== Inventory Ledger Reconciliation (READ-ONLY) ===");
      console.log(`Ledger rows replayed:   ${ledgerRows.length}`);
      console.log(`Cells checked:          ${result.cellsChecked}`);
      console.log(`Cells with variance:    ${result.variances.length}`);
      console.log(`Total absolute drift:   ${result.totalAbsDrift} variant-units`);
      console.log("");

      if (result.variances.length === 0) {
        console.log("✅ Zero variance — ledger reconciles to inventory_levels.");
      } else {
        const shown = limited.length;
        console.log(
          `Top ${shown} variance(s) (actual − expected), largest drift first:`,
        );
        console.log("");
        console.log("  variant   location   expected   actual    diff");
        console.log("  -------   --------   --------   ------   -----");
        for (const v of limited) {
          console.log(
            `  ${String(v.productVariantId).padStart(7)}   ` +
              `${String(v.warehouseLocationId).padStart(8)}   ` +
              `${String(v.expected).padStart(8)}   ` +
              `${String(v.actual).padStart(6)}   ` +
              `${(v.diff > 0 ? "+" : "") + v.diff}`.padStart(5),
          );
        }
        if (opts.limit != null && result.variances.length > opts.limit) {
          console.log("");
          console.log(
            `  … and ${result.variances.length - opts.limit} more (raise --limit to see all)`,
          );
        }
      }
      console.log("");
    }

    process.exitCode = result.variances.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Reconciler failed:", err);
  process.exit(2);
});
