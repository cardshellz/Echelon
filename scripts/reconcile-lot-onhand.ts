/**
 * Lot → levels on-hand reconciler (READ-ONLY).
 *
 * Sums `inventory.inventory_lots.qty_on_hand` per (variant, location) and diffs it
 * against `inventory.inventory_levels.variant_qty`. The trust ORACLE for the
 * Lot-Identity & Lineage arc (see WMS-INVENTORY-REFACTOR.md §6) — the regression gate
 * for L1–L3, which move lot storage onto a lot↔location quantity table. The lot-vs-
 * level on-hand sum must stay at zero variance through every migration step. Makes
 * NO writes.
 *
 * Usage:
 *   npm run wms:reconcile-lots
 *   npm run wms:reconcile-lots -- --json
 *   npm run wms:reconcile-lots -- --limit=50      # top N variances
 *   npm run wms:reconcile-lots -- --variant=1234  # one variant only
 *
 * Connection: DATABASE_URL.
 * Exit code: 0 if zero variance, 1 if any variance found (CI-gateable), 2 on no DB.
 */

import pg from "pg";
import {
  sumLotsOnHand,
  reconcile,
  type LotRow,
  type LevelRow,
} from "../server/modules/inventory/reconcile/lot-onhand-replay";

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
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(2);
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const variantFilter = opts.variantId
      ? `AND product_variant_id = ${opts.variantId}`
      : "";

    // 1. Pull per-lot on-hand rows and sum them in JS (exercises the pure,
    //    unit-tested summation; mirrors how the ledger reconciler replays in JS).
    const lotRes = await pool.query(
      `SELECT product_variant_id    AS "productVariantId",
              warehouse_location_id AS "warehouseLocationId",
              qty_on_hand           AS "qtyOnHand"
         FROM inventory.inventory_lots
         WHERE 1=1 ${variantFilter}`,
    );

    const lotRows: LotRow[] = lotRes.rows.map((r) => ({
      productVariantId: Number(r.productVariantId),
      warehouseLocationId: Number(r.warehouseLocationId),
      qtyOnHand: Number(r.qtyOnHand),
    }));

    const expected = sumLotsOnHand(lotRows);

    // 2. Load actual levels (on-hand bucket).
    const levelsRes = await pool.query(
      `SELECT product_variant_id    AS "productVariantId",
              warehouse_location_id AS "warehouseLocationId",
              variant_qty           AS "variantQty"
         FROM inventory.inventory_levels
         WHERE 1=1 ${variantFilter}`,
    );

    const levels: LevelRow[] = levelsRes.rows.map((r) => ({
      productVariantId: Number(r.productVariantId),
      warehouseLocationId: Number(r.warehouseLocationId),
      variantQty: Number(r.variantQty),
    }));

    // 3. Reconcile (shared diff machinery; expected = SUM(lot.qty_on_hand)).
    const result = reconcile(expected, levels);

    const limited =
      opts.limit != null ? result.variances.slice(0, opts.limit) : result.variances;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            lotRows: lotRows.length,
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
      console.log("=== Lot → Levels On-Hand Reconciliation (READ-ONLY) ===");
      console.log(`Lot rows summed:        ${lotRows.length}`);
      console.log(`Cells checked:          ${result.cellsChecked}`);
      console.log(`Cells with variance:    ${result.variances.length}`);
      console.log(`Total absolute drift:   ${result.totalAbsDrift} variant-units`);
      console.log("");

      if (result.variances.length === 0) {
        console.log("✅ Zero variance — lot on-hand reconciles to inventory_levels.");
      } else {
        const shown = limited.length;
        console.log(
          `Top ${shown} variance(s) (level − lot sum), largest drift first:`,
        );
        console.log("");
        console.log("  variant   location   lot_sum     level    diff");
        console.log("  -------   --------   -------     -----   -----");
        for (const v of limited) {
          console.log(
            `  ${String(v.productVariantId).padStart(7)}   ` +
              `${String(v.warehouseLocationId).padStart(8)}   ` +
              `${String(v.expected).padStart(7)}   ` +
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
  console.error("Lot reconciler failed:", err);
  process.exit(2);
});
