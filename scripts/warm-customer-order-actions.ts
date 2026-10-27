import { parseOrderActionWarmOptions } from "./lib/order-action-warm-options";

async function main() {
  const options = parseOrderActionWarmOptions(process.argv.slice(2));
  const audit = { action: "customer_order_actions_warm", actor: options.actor, orderIds: options.orderIds };
  console.log(JSON.stringify({ ...audit, outcome: options.execute ? "started" : "dry_run", passes: options.passes }));
  // Validate and report dry runs before importing any database/composition code.
  if (!options.execute) return;
  const { db, pool } = await import("../server/db");
  try {
    const { createServices } = await import("../server/services");
    const { createOrderEditService } = await import("../server/modules/order-edits/order-edit.composition");
    const { createOrderActionProjectionWorker } = await import("../server/modules/customer-account/infrastructure/order-action-projection.composition");
    const worker = createOrderActionProjectionWorker(pool, createOrderEditService(pool, createServices(db, pool)),
      event => console.log(JSON.stringify({ ...event, actor: options.actor })), { orderIds: options.orderIds });
    for (let pass = 0; pass < options.passes; pass++) await worker.run();
    console.log(JSON.stringify({ ...audit, outcome: "finished" }));
  } finally { await pool.end(); }
}
main().catch(() => {
  console.error(JSON.stringify({ action: "customer_order_actions_warm", outcome: "failed", code: "ORDER_ACTION_WARM_FAILED" }));
  process.exitCode = 1;
});
