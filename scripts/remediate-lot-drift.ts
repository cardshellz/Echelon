/**
 * L0.5 — Lot-drift remediation (lot layer → inventory_levels).
 *
 * One-time corrective pass for the Lot Identity & Lineage arc (WMS-INVENTORY-REFACTOR.md §6).
 * Phases 0–1 reconciled the LEDGER to `inventory_levels` (the trusted on-hand spine). The
 * `inventory_lots` cost-layer was never tied to levels and has diverged (see
 * `wms:reconcile-lots`). This brings the lot layer into agreement with the EXISTING levels
 * so the lot→levels reconciler reaches zero — the prerequisite for the storage migration (L1+).
 *
 * IMPORTANT — lot layer ONLY:
 *   - It mutates `inventory.inventory_lots` exclusively. It does NOT touch
 *     `inventory.inventory_levels` (already correct) and writes NO
 *     `inventory.inventory_transactions` row (an on-hand ledger row with no matching level
 *     change would BREAK the Phase 0 ledger→levels reconciler, which is at zero). The audit
 *     trail is the remediation lots themselves: cost_source='legacy', a LOT-RECON-* number,
 *     and a batch tag in notes.
 *
 * Per drifting (variant, location) cell:
 *   - level > lot  → CREATE a remediation lot for the shortfall. Cost (A) = the variant's
 *     avg_cost_cents (else last_cost_cents); (B) if neither is set → $0 with cost_provisional=1
 *     (cost backfilled later via the lot-cost CSV upload). Written in mills + cent mirrors.
 *   - lot > level  → DEPLETE the excess qty_on_hand from the cell's lots, oldest first
 *     (depleted at 0).
 *
 * SAFETY: DRY-RUN by default (no writes). Pass --apply to write, inside one transaction.
 * Idempotent: re-running after a successful apply finds zero drift and does nothing.
 *
 *   npx tsx scripts/remediate-lot-drift.ts             # dry-run (default)
 *   npx tsx scripts/remediate-lot-drift.ts --limit=30  # dry-run, show 30 sample cells
 *   npx tsx scripts/remediate-lot-drift.ts --apply     # WRITE (lot layer only)
 *
 * Connection: EXTERNAL_DATABASE_URL (per CLAUDE.md), falling back to DATABASE_URL.
 * Verify after apply with: npm run wms:reconcile-lots  (expect zero variance).
 */

import pg from "pg";

const { Pool } = pg;

interface CliOptions {
  apply: boolean;
  json: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, json: false, limit: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.split("=")[1]) || null;
  }
  return opts;
}

interface Cell {
  pv: number;
  loc: number;
  lotQty: number;
  lvlQty: number;
  costCents: number; // resolved A cost (avg→last), 0 if none on file
}

async function main() {
  const opts = parseArgs(process.argv);
  const connectionString =
    process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: EXTERNAL_DATABASE_URL (or DATABASE_URL) is not set.");
    process.exit(2);
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const batch = `L05-LOTRECON-${stamp}`;

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    // 1. Drifting cells + the variant's on-file cost (avg→last→0).
    const res = await pool.query(`
      WITH lot_sums AS (
        SELECT product_variant_id pv, warehouse_location_id loc, SUM(qty_on_hand) lot_qty
        FROM inventory.inventory_lots GROUP BY 1,2
      )
      SELECT COALESCE(l.product_variant_id, s.pv)            AS pv,
             COALESCE(l.warehouse_location_id, s.loc)        AS loc,
             COALESCE(s.lot_qty,0)::int                      AS lot_qty,
             COALESCE(l.variant_qty,0)::int                  AS lvl_qty,
             COALESCE(NULLIF(pv.avg_cost_cents,0), NULLIF(pv.last_cost_cents,0), 0)::bigint AS cost_cents
      FROM inventory.inventory_levels l
      FULL OUTER JOIN lot_sums s
        ON s.pv = l.product_variant_id AND s.loc = l.warehouse_location_id
      LEFT JOIN catalog.product_variants pv ON pv.id = COALESCE(l.product_variant_id, s.pv)
      WHERE COALESCE(l.variant_qty,0) <> COALESCE(s.lot_qty,0)
        AND COALESCE(l.variant_qty,0) >= 0
        AND COALESCE(s.lot_qty,0) >= 0
      ORDER BY pv, loc
    `);

    const cells: Cell[] = res.rows.map((r) => ({
      pv: Number(r.pv),
      loc: Number(r.loc),
      lotQty: Number(r.lot_qty),
      lvlQty: Number(r.lvl_qty),
      costCents: Number(r.cost_cents),
    }));

    const topups = cells
      .filter((c) => c.lvlQty > c.lotQty)
      .map((c) => ({ ...c, qty: c.lvlQty - c.lotQty }));
    const deplete = cells
      .filter((c) => c.lotQty > c.lvlQty)
      .map((c) => ({ ...c, qty: c.lotQty - c.lvlQty }));

    const topupWithCost = topups.filter((t) => t.costCents > 0);
    const topupZeroCost = topups.filter((t) => t.costCents === 0);
    const topupUnits = topups.reduce((s, t) => s + t.qty, 0);
    const depleteUnits = deplete.reduce((s, t) => s + t.qty, 0);

    console.log("");
    console.log(`=== L0.5 Lot-Drift Remediation ${opts.apply ? "(APPLY)" : "(DRY-RUN — no writes)"} ===`);
    console.log(`Batch tag:            ${batch}`);
    console.log(`Top-up cells:         ${topups.length}  (+${topupUnits} units → create remediation lots)`);
    console.log(`  • with cost (A):    ${topupWithCost.length}  (variant avg/last cost)`);
    console.log(`  • $0 provisional(B):${topupZeroCost.length}  (no cost on file → CSV-backfill later)`);
    console.log(`Deplete cells:        ${deplete.length}  (-${depleteUnits} units → reduce lot on-hand FIFO)`);
    console.log("");

    if (opts.limit != null) {
      console.log(`Sample cells (first ${opts.limit}):`);
      console.log("  pv      loc     lot→lvl    action");
      for (const c of cells.slice(0, opts.limit)) {
        const action =
          c.lvlQty > c.lotQty
            ? `topup +${c.lvlQty - c.lotQty} @ ${c.costCents > 0 ? "$" + (c.costCents / 100).toFixed(2) : "$0 prov"}`
            : `deplete -${c.lotQty - c.lvlQty}`;
        console.log(
          `  ${String(c.pv).padStart(6)}  ${String(c.loc).padStart(6)}  ${String(c.lotQty).padStart(5)}→${String(c.lvlQty).padEnd(5)}  ${action}`,
        );
      }
      console.log("");
    }

    if (!opts.apply) {
      console.log("DRY-RUN complete. No rows written. Re-run with --apply to write (lot layer only).");
      console.log("After --apply, verify with: npm run wms:reconcile-lots  (expect zero variance).");
      console.log("");
      return; // pool closed in finally
    }

    // 2. APPLY — one transaction, lot layer only.
    const client = await pool.connect();
    let created = 0;
    let depletedLots = 0;
    let lotCounter = 0;
    try {
      await client.query("BEGIN");

      // 2a. Top-ups: create one remediation lot per cell.
      for (const t of topups) {
        lotCounter += 1;
        const lotNumber = `LOT-RECON-${stamp}-${String(lotCounter).padStart(4, "0")}`;
        const costCents = t.costCents; // A (>0) or B (0)
        const costMills = costCents * 100;
        const provisional = costCents === 0 ? 1 : 0;
        await client.query(
          `INSERT INTO inventory.inventory_lots
             (lot_number, product_variant_id, warehouse_location_id, received_at,
              qty_on_hand, qty_received, qty_reserved, qty_picked,
              unit_cost_cents, po_unit_cost_cents, packaging_cost_cents, landed_cost_cents, total_unit_cost_cents,
              unit_cost_mills, po_unit_cost_mills, packaging_cost_mills, landed_cost_mills, total_unit_cost_mills,
              cost_source, cost_provisional, status, notes)
           VALUES ($1,$2,$3, now(),
              $4,$4,0,0,
              $5,$5,0,0,$5,
              $6,$6,0,0,$6,
              'legacy',$7,'active',$8)`,
          [
            lotNumber,
            t.pv,
            t.loc,
            t.qty,
            costCents,
            costMills,
            provisional,
            `L0.5 lot-drift remediation (${batch}); level had stock with no/short lots`,
          ],
        );
        created += 1;
      }

      // 2b. Depletes: reduce qty_on_hand across the cell's lots, oldest first.
      for (const d of deplete) {
        let remaining = d.qty;
        const lotsRes = await client.query(
          `SELECT id, qty_on_hand FROM inventory.inventory_lots
             WHERE product_variant_id=$1 AND warehouse_location_id=$2 AND qty_on_hand > 0
             ORDER BY received_at ASC, id ASC`,
          [d.pv, d.loc],
        );
        for (const lot of lotsRes.rows) {
          if (remaining <= 0) break;
          const take = Math.min(Number(lot.qty_on_hand), remaining);
          await client.query(
            `UPDATE inventory.inventory_lots
               SET qty_on_hand = qty_on_hand - $1,
                   status = CASE WHEN (qty_on_hand - $1) = 0 AND qty_reserved = 0 AND qty_picked = 0 THEN 'depleted' ELSE status END,
                   notes = COALESCE(notes,'') || $3
               WHERE id = $2`,
            [take, lot.id, ` | L0.5 deplete -${take} (${batch})`],
          );
          remaining -= take;
          depletedLots += 1;
        }
        if (remaining > 0) {
          console.warn(`  ⚠ cell pv=${d.pv} loc=${d.loc}: could not deplete full ${d.qty} (short by ${remaining}) — insufficient lot on-hand`);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`APPLIED: created ${created} remediation lot(s), depleted across ${depletedLots} lot(s).`);
    console.log(`Now run: npm run wms:reconcile-lots  (expect zero variance).`);
    console.log("");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Lot-drift remediation failed:", err);
  process.exit(2);
});
