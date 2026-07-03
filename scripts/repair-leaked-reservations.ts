/**
 * P0.1d — Leaked-reservation repair (reserved_qty → open order demand).
 *
 * Context (ARCHITECTURE-AUDIT-2026-07.md F1, prod-confirmed 2026-07-02):
 * until P0.1a, every paid order could be reserved TWICE — once by WMS sync
 * (WMS ids) and once by the OMS-side reserveInventory (OMS ids); the OMS-keyed
 * half had no release path and leaked permanently (5,372 orphan reserve rows
 * across 197 variants). Reconciler cancels also released nothing (fixed in
 * P0.1c). This script reconciles the reservation COUNTERS back to truth:
 *
 *   target_reserved(variant) = Σ over items of non-terminal WMS orders of
 *                              GREATEST(0, quantity − picked)
 *
 * where `picked` is the CONSERVATIVE (lower) of the item's picked_quantity
 * column and its ledger pick rows — under-counting picks raises the target
 * and makes us release LESS, never more. Only positive drift
 * (current > target) is repaired, per-variant, inside a transaction holding
 * the same advisory lock the live reserve path takes (918410), with drift
 * recomputed under the lock. Lot-level qty_reserved is trimmed to match,
 * newest lots first (mirror of releaseFromLots). Every release writes a
 * ledgered `unreserve` row (reserved_qty_delta, reference_type='manual',
 * reference_id='repair-leaked-reservations').
 *
 * KNOWN CONSERVATISM: orders held for reservation shortfall (P0.1c) count
 * toward the target even though they hold no reservation — their variants
 * under-release until the hold resolves. Re-run after holds clear.
 *
 * SAFETY: DRY-RUN by default (no writes). Idempotent — a re-run after apply
 * finds zero drift.
 *
 *   npx tsx scripts/repair-leaked-reservations.ts                # dry-run report
 *   npx tsx scripts/repair-leaked-reservations.ts --limit=50     # dry-run, wider sample
 *   npx tsx scripts/repair-leaked-reservations.ts --variant=207  # scope to one variant
 *   npx tsx scripts/repair-leaked-reservations.ts --apply        # WRITE
 *
 * Connection: EXTERNAL_DATABASE_URL (per CLAUDE.md), falling back to DATABASE_URL.
 * Verify after apply: re-run without --apply (expect zero drift rows).
 */

import pg from "pg";

const { Pool } = pg;

const RESERVATION_LOCK_NS = 918410; // must match reservation.service.ts

interface CliOptions {
  apply: boolean;
  limit: number;
  variantId: number | null;
}

function parseCli(): CliOptions {
  const opts: CliOptions = { apply: false, limit: 25, variantId: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--limit=")) opts.limit = Math.max(1, Number(arg.split("=")[1]) || 25);
    else if (arg.startsWith("--variant=")) opts.variantId = Number(arg.split("=")[1]) || null;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * Per-variant drift: current reserved counters vs open active-order demand.
 * `picked` per item = LEAST(picked_quantity column, ledger pick rows) —
 * the conservative choice (see header).
 */
const DRIFT_SQL = `
  WITH active_demand AS (
    SELECT pv.id AS variant_id,
           SUM(GREATEST(0, oi.quantity - LEAST(COALESCE(oi.picked_quantity, 0), COALESCE(lp.picked, 0)))) AS target_reserved
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    JOIN catalog.product_variants pv ON pv.sku = oi.sku
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(-it.variant_qty_delta), 0) AS picked
      FROM inventory.inventory_transactions it
      WHERE it.order_id = oi.order_id
        AND it.order_item_id = oi.id
        AND it.transaction_type = 'pick'
        AND it.voided_at IS NULL
    ) lp ON TRUE
    WHERE o.warehouse_status NOT IN ('cancelled', 'shipped')
    GROUP BY pv.id
  ),
  reserved_now AS (
    SELECT il.product_variant_id AS variant_id,
           SUM(il.reserved_qty) AS current_reserved
    FROM inventory.inventory_levels il
    WHERE il.reserved_qty > 0
    GROUP BY il.product_variant_id
  )
  SELECT r.variant_id,
         pv.sku,
         r.current_reserved::int,
         COALESCE(a.target_reserved, 0)::int AS target_reserved,
         (r.current_reserved - COALESCE(a.target_reserved, 0))::int AS drift
  FROM reserved_now r
  JOIN catalog.product_variants pv ON pv.id = r.variant_id
  LEFT JOIN active_demand a ON a.variant_id = r.variant_id
  WHERE r.current_reserved > COALESCE(a.target_reserved, 0)
`;

async function main(): Promise<void> {
  const opts = parseCli();
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("EXTERNAL_DATABASE_URL / DATABASE_URL not set");
    process.exit(1);
  }
  // ssl matches the repo's other pools/scripts (see db.ts, remediate-lot-drift):
  // Heroku PG requires TLS; certificate verification is a known repo-wide
  // gap tracked as P4.5 in REFACTOR-PLAN-2026-07.md.
  const pool = new Pool({ connectionString, max: 2, ssl: { rejectUnauthorized: false } });

  try {
    const scope = opts.variantId ? ` AND r.variant_id = ${Number(opts.variantId)}` : "";
    const driftRows = await pool.query(
      `${DRIFT_SQL}${scope} ORDER BY (r.current_reserved - COALESCE(a.target_reserved, 0)) DESC`,
    );

    if (driftRows.rows.length === 0) {
      console.log("No positive reservation drift found. Nothing to repair.");
      return;
    }

    console.log(
      `${opts.apply ? "APPLY" : "DRY-RUN"}: ${driftRows.rows.length} variant(s) with leaked reservations ` +
        `(showing up to ${opts.limit}):\n`,
    );
    console.log("variant_id | sku | current_reserved | target_reserved | drift");
    for (const row of driftRows.rows.slice(0, opts.limit)) {
      console.log(
        `${row.variant_id} | ${row.sku} | ${row.current_reserved} | ${row.target_reserved} | ${row.drift}`,
      );
    }
    const totalDrift = driftRows.rows.reduce((s: number, r: any) => s + Number(r.drift), 0);
    console.log(`\nTotal leaked units (variant units): ${totalDrift}`);

    if (!opts.apply) {
      console.log("\nDry-run complete. Re-run with --apply to release the leaked reservations.");
      return;
    }

    let repairedVariants = 0;
    let releasedUnits = 0;

    for (const row of driftRows.rows) {
      const variantId = Number(row.variant_id);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Same lock the live reserve path takes — no racing a live reservation.
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [RESERVATION_LOCK_NS, variantId]);

        // Recompute under the lock — the world may have moved.
        const fresh = await client.query(
          `${DRIFT_SQL} AND r.variant_id = $1`,
          [variantId],
        );
        const freshRow = fresh.rows[0];
        let remaining = Number(freshRow?.drift ?? 0);
        if (remaining <= 0) {
          await client.query("ROLLBACK");
          console.log(`variant ${variantId}: drift resolved concurrently — skipped`);
          continue;
        }

        const levels = await client.query(
          `SELECT id, warehouse_location_id, reserved_qty, variant_qty
           FROM inventory.inventory_levels
           WHERE product_variant_id = $1 AND reserved_qty > 0
           ORDER BY reserved_qty DESC
           FOR UPDATE`,
          [variantId],
        );

        for (const level of levels.rows) {
          if (remaining <= 0) break;
          const q = Math.min(Number(level.reserved_qty), remaining);
          if (q <= 0) continue;

          const upd = await client.query(
            `UPDATE inventory.inventory_levels
             SET reserved_qty = reserved_qty - $1, updated_at = NOW()
             WHERE id = $2 AND reserved_qty >= $1`,
            [q, level.id],
          );
          if (upd.rowCount !== 1) continue;

          await client.query(
            `INSERT INTO inventory.inventory_transactions
               (product_variant_id, from_location_id, transaction_type,
                variant_qty_delta, variant_qty_before, variant_qty_after,
                reserved_qty_delta, source_state, target_state,
                reference_type, reference_id, notes, is_implicit, user_id)
             VALUES ($1, $2, 'unreserve', 0, $3, $3, $4, 'committed', 'on_hand',
                     'manual', 'repair-leaked-reservations',
                     'P0.1d: released leaked reservation (no owning active order)', 1, 'repair-script')`,
            [variantId, level.warehouse_location_id, level.variant_qty, -q],
          );

          // Trim lot-level reservations at this location, newest first
          // (mirror of releaseFromLots), so lots stay in agreement with the level.
          let lotRemaining = q;
          const lots = await client.query(
            `SELECT id, qty_reserved
             FROM inventory.inventory_lots
             WHERE product_variant_id = $1 AND warehouse_location_id = $2 AND qty_reserved > 0
             ORDER BY received_at DESC, id DESC
             FOR UPDATE`,
            [variantId, level.warehouse_location_id],
          );
          for (const lot of lots.rows) {
            if (lotRemaining <= 0) break;
            const lq = Math.min(Number(lot.qty_reserved), lotRemaining);
            await client.query(
              `UPDATE inventory.inventory_lots
               SET qty_reserved = qty_reserved - $1
               WHERE id = $2 AND qty_reserved >= $1`,
              [lq, lot.id],
            );
            lotRemaining -= lq;
          }

          remaining -= q;
          releasedUnits += q;
        }

        await client.query("COMMIT");
        repairedVariants++;
        console.log(
          `variant ${variantId} (${freshRow.sku}): released ${Number(freshRow.drift) - remaining} leaked unit(s)` +
            (remaining > 0 ? ` — ${remaining} unaccounted (counters below ledger; see drift check)` : ""),
        );
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`variant ${variantId}: repair failed — ${err?.message}`);
      } finally {
        client.release();
      }
    }

    console.log(
      `\nDone. Repaired ${repairedVariants}/${driftRows.rows.length} variant(s), released ${releasedUnits} unit(s).`,
    );
    console.log("Re-run without --apply to verify zero remaining drift.");
    console.log("NOTE: Shopify quantities update on the next inventory change or manual POST /api/sync/trigger.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
