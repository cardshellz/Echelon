/**
 * One-off backfill: re-push historical orders to Mission Control so the
 * fields mc-push learned to send late — discount codes, and now marketing
 * consent — land there.
 *
 * Two gaps this repairs:
 *   1. Discount codes. Orders pushed before mc-push forwarded
 *      `discount_codes` reached MC without them, so MC cannot attribute
 *      coupon redemptions to the campaign that issued the code.
 *   2. Marketing consent + buyer identity. Orders pushed before mc-push
 *      forwarded `marketing_consent` / `external_customer_id` created no CRM
 *      profile at all, so every historical purchaser is invisible to the CRM
 *      — the exact list growth the Klaviyo cutover depends on.
 *
 * MC's ingest is an idempotent upsert keyed on (workspace, source,
 * external_order_id), and its CRM link dedupes consent by value, so
 * re-pushing an order is safe: it updates the existing row and appends
 * nothing it already holds.
 *
 * Usage:
 *   npx tsx scripts/backfill-mc-discount-codes.ts --since 2026-08-01 [--dry-run]
 *
 * Only orders whose raw payload carries something MC can act on are pushed —
 * there is no reason to rewrite rows that would be unchanged.
 */
import { and, gte, isNotNull } from "drizzle-orm";

import { db } from "../server/db";
import { omsOrders } from "@shared/schema";
import { extractDiscountCodes, pushToMissionControl } from "../server/modules/oms/mc-push";
import { extractMarketingConsent } from "../server/modules/oms/marketing-consent";

const LOG_PREFIX = "[backfill-mc-orders]";

/**
 * MC's ingest switch only accepts its known event vocabulary and 400s on
 * anything else. A backfill is an update of an existing order, so it must
 * ride the update event — MC auto-creates the row if it is missing.
 */
const BACKFILL_EVENT = "order.updated";

function parseArgs(argv: string[]): { since: Date; dryRun: boolean } {
  const sinceIndex = argv.indexOf("--since");
  if (sinceIndex === -1 || argv[sinceIndex + 1] === undefined) {
    throw new Error("--since <YYYY-MM-DD> is required");
  }
  const since = new Date(argv[sinceIndex + 1]);
  if (Number.isNaN(since.getTime())) throw new Error(`invalid --since date: ${argv[sinceIndex + 1]}`);
  return { since, dryRun: argv.includes("--dry-run") };
}

/** Does re-pushing this order tell MC anything it could not have known? */
function backfillReasons(rawPayload: unknown): string[] {
  const reasons: string[] = [];

  const codes = extractDiscountCodes(rawPayload);
  if (codes.length > 0) reasons.push(`codes:${codes.map((c) => c.code).join("/")}`);

  // Only actionable consent states are worth a push. not_subscribed / pending
  // / unknown produce no ledger row on MC's side, so re-pushing for them
  // would be work with no outcome.
  const consent = extractMarketingConsent(rawPayload);
  for (const [channel, snapshot] of [["email", consent.email], ["sms", consent.sms]] as const) {
    if (snapshot.state === "subscribed" || snapshot.state === "unsubscribed") {
      reasons.push(`${channel}:${snapshot.state}`);
    }
  }

  return reasons;
}

async function main(): Promise<void> {
  const { since, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} scanning orders since ${since.toISOString()}${dryRun ? " (dry run)" : ""}`);

  const orders = await db
    .select({ id: omsOrders.id, orderedAt: omsOrders.orderedAt, rawPayload: omsOrders.rawPayload })
    .from(omsOrders)
    .where(and(gte(omsOrders.orderedAt, since), isNotNull(omsOrders.rawPayload)));

  let actionable = 0;
  let pushed = 0;
  for (const order of orders) {
    const reasons = backfillReasons(order.rawPayload);
    if (reasons.length === 0) continue;
    actionable += 1;
    if (dryRun) {
      console.log(`${LOG_PREFIX} would push order ${order.id}: ${reasons.join(", ")}`);
      continue;
    }
    // Sequential on purpose: this is a background repair, not a race for
    // throughput, and MC's ingest is a single-row upsert per call.
    await pushToMissionControl(order.id, BACKFILL_EVENT);
    pushed += 1;
  }

  console.log(
    `${LOG_PREFIX} scanned ${orders.length} orders, ${actionable} carry codes or consent, ${dryRun ? 0 : pushed} pushed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`${LOG_PREFIX} failed:`, error instanceof Error ? error.message : error);
    process.exit(1);
  });
