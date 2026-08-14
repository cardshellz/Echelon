/**
 * One-off backfill: re-push historical orders to Mission Control so their
 * discount codes land there.
 *
 * mc-push only started forwarding `discount_codes` recently; every order
 * pushed before that reached MC without them, so MC cannot attribute
 * coupon redemptions to the campaign that issued the code. MC's ingest is an
 * idempotent upsert keyed on (workspace, source, external_order_id), so
 * re-pushing an order is safe — it updates the existing row rather than
 * duplicating it.
 *
 * Usage:
 *   npx tsx scripts/backfill-mc-discount-codes.ts --since 2026-08-01 [--dry-run]
 *
 * Only orders whose raw payload actually carries codes are pushed — there is
 * no reason to rewrite rows that would be unchanged.
 */
import { and, gte, isNotNull } from "drizzle-orm";

import { db } from "../server/db";
import { omsOrders } from "@shared/schema";
import { extractDiscountCodes, pushToMissionControl } from "../server/modules/oms/mc-push";

const LOG_PREFIX = "[backfill-discount-codes]";

function parseArgs(argv: string[]): { since: Date; dryRun: boolean } {
  const sinceIndex = argv.indexOf("--since");
  if (sinceIndex === -1 || argv[sinceIndex + 1] === undefined) {
    throw new Error("--since <YYYY-MM-DD> is required");
  }
  const since = new Date(argv[sinceIndex + 1]);
  if (Number.isNaN(since.getTime())) throw new Error(`invalid --since date: ${argv[sinceIndex + 1]}`);
  return { since, dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { since, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} scanning orders since ${since.toISOString()}${dryRun ? " (dry run)" : ""}`);

  const orders = await db
    .select({ id: omsOrders.id, orderedAt: omsOrders.orderedAt, rawPayload: omsOrders.rawPayload })
    .from(omsOrders)
    .where(and(gte(omsOrders.orderedAt, since), isNotNull(omsOrders.rawPayload)));

  let withCodes = 0;
  let pushed = 0;
  for (const order of orders) {
    const codes = extractDiscountCodes(order.rawPayload);
    if (codes.length === 0) continue;
    withCodes += 1;
    if (dryRun) {
      console.log(`${LOG_PREFIX} would push order ${order.id}: ${codes.map((c) => c.code).join(", ")}`);
      continue;
    }
    // Sequential on purpose: this is a background repair, not a race for
    // throughput, and MC's ingest is a single-row upsert per call.
    await pushToMissionControl(order.id, "order.backfill");
    pushed += 1;
  }

  console.log(
    `${LOG_PREFIX} scanned ${orders.length} orders, ${withCodes} carry discount codes, ${dryRun ? 0 : pushed} pushed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`${LOG_PREFIX} failed:`, error instanceof Error ? error.message : error);
    process.exit(1);
  });
