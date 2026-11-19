/**
 * Run-Once Order Maintenance Script (`P1.5` / `P1.7`)
 *
 * Replaces every-deploy one-shot `setTimeout(...)` repairs formerly inline in
 * `server/index.ts`. Gated by `public.scheduler_runs` (`runOneShotIfNeverCompleted`)
 * and PostgreSQL session advisory locks.
 *
 * Usage:
 *   npx tsx scripts/maintenance/run-one-shot-order-repairs.ts [--force-sort-rank]
 */

import { db, pool } from "../../server/db";
import { createServices } from "../../server/services";
import {
  runOneTimeActiveSortRankRecompute,
  runRetiredDuplicateShipmentCleanup,
} from "../../server/modules/orders/reconciliation-and-repair.api";

async function main(): Promise<void> {
  const forceSortRank = process.argv.includes("--force-sort-rank");
  const services = createServices(db, pool);

  const sortRankOutcome = await runOneTimeActiveSortRankRecompute({
    db,
    force: forceSortRank,
  });
  console.log("[one-shot-order-repairs] sort_rank recompute:", JSON.stringify(sortRankOutcome));

  const duplicateCleanupOutcome = await runRetiredDuplicateShipmentCleanup({
    db,
    shippingEngine: services.shippingEngine,
  });
  console.log(
    "[one-shot-order-repairs] retired duplicate shipment cleanup:",
    JSON.stringify(duplicateCleanupOutcome),
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[one-shot-order-repairs] fatal error:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
