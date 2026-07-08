/**
 * One-shot recovery for paid line items that were left UNAUTHORIZED by the
 * 2026-07 orders/paid + orders/updated webhook race (fixed in
 * fix/oms-line-authority-webhook-race). Those lines are stuck
 * authorization_status='seen' with authority_fulfillable_quantity=0, so
 * wms-sync skipped them — they never materialized to WMS or pushed to
 * ShipStation. The order shows paid + unfulfilled with items silently missing.
 *
 * FINGERPRINT (the exact stuck state; conservative to avoid touching genuine
 * cancels/refunds or in-flight orders):
 *   - order financial_status paid/partially_paid, not cancelled/refunded/fulfilled
 *   - line requires_shipping, quantity > 0, cancelled_quantity = 0, refunded_quantity = 0
 *   - line authorization_status <> 'authorized' AND wms_materialized_quantity < quantity
 *   - order created > 15 min ago (past the live webhook-processing window)
 *
 * RECOVERY per line: re-authorize from order-paid truth via the canonical
 * deriveOmsLineAuthority (sourceTopic 'reconciler/authorize', an authorizing
 * topic) inside a FOR UPDATE transaction (re-checks the fingerprint under lock),
 * write the authority ledger event, then re-sync the order:
 * wmsSync.syncOmsOrderToWms materializes the now-authorized lines, adds them to
 * a shipment, and pushes to ShipStation (reconcileExistingWmsOrderLines Case A/B).
 * Reservation shortfalls no longer hold the order (auto-hold removed 2026-07-06),
 * so the push proceeds and any unstocked line surfaces as a pick short.
 *
 * SAFETY: DRY-RUN by default. Idempotent — a re-run after apply finds nothing
 * (authorized lines no longer match the fingerprint).
 *
 *   npx tsx scripts/recover-unauthorized-paid-lines.ts                 # dry-run report
 *   npx tsx scripts/recover-unauthorized-paid-lines.ts --order=60047   # dry-run, one order
 *   npx tsx scripts/recover-unauthorized-paid-lines.ts --apply         # re-authorize + re-sync + push
 *
 * On Heroku:
 *   heroku run -a cardshellz-echelon -- npx tsx scripts/recover-unauthorized-paid-lines.ts --apply
 *
 * Verify after apply: re-run without --apply (expect zero rows); spot-check the
 * orders show fulfilled/ready and the items are on ShipStation.
 */

import { db } from "../server/db";
import { sql, eq } from "drizzle-orm";
import { omsOrderLines } from "@shared/schema/oms.schema";
import { createServices } from "../server/services";
import { deriveOmsLineAuthority } from "../server/modules/oms/oms-line-authority";
import { recordOmsLineAuthorityEvent } from "../server/modules/oms/oms-line-authority-ledger";

interface CliOptions {
  apply: boolean;
  limit: number;
  order: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, limit: 1000, order: null };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isInteger(n) && n > 0) opts.limit = n;
    } else if (arg.startsWith("--order=")) {
      opts.order = arg.slice("--order=".length).trim() || null;
    }
  }
  return opts;
}

interface AffectedLine {
  omsOrderId: number;
  externalOrderNumber: string | null;
  lineId: number;
  sku: string | null;
  quantity: number;
}

const SOURCE_EVENT_ID = "reconciler:recover-unauthorized-paid-lines";

async function findAffectedLines(opts: CliOptions): Promise<AffectedLine[]> {
  const rows: any = await db.execute(sql`
    SELECT o.id AS oms_order_id, o.external_order_number, l.id AS line_id, l.sku, l.quantity
    FROM oms.oms_orders o
    JOIN oms.oms_order_lines l ON l.order_id = o.id
    WHERE o.financial_status IN ('paid','partially_paid')
      AND o.status NOT IN ('cancelled','refunded')
      AND COALESCE(o.fulfillment_status,'') <> 'fulfilled'
      AND l.requires_shipping = true
      AND l.quantity > 0
      AND COALESCE(l.cancelled_quantity,0) = 0
      AND COALESCE(l.refunded_quantity,0) = 0
      AND l.authorization_status <> 'authorized'
      AND COALESCE(l.wms_materialized_quantity,0) < l.quantity
      AND o.created_at < NOW() - INTERVAL '15 minutes'
      ${opts.order ? sql`AND o.external_order_number = ${opts.order}` : sql``}
    ORDER BY o.created_at DESC, l.id
    LIMIT ${opts.limit}
  `);
  return (rows?.rows ?? []).map((r: any) => ({
    omsOrderId: Number(r.oms_order_id),
    externalOrderNumber: r.external_order_number ?? null,
    lineId: Number(r.line_id),
    sku: r.sku ?? null,
    quantity: Number(r.quantity ?? 0),
  }));
}

/** Re-authorize one stuck line under a row lock. Returns true if it authorized. */
async function reauthorizeLine(omsOrderId: number, lineId: number): Promise<boolean> {
  return await db.transaction(async (tx: any) => {
    const [current] = await tx
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.id, lineId))
      .for("update")
      .limit(1);
    if (!current) return false;
    // Re-check the fingerprint under lock — skip anything that changed.
    if (current.authorizationStatus === "authorized") return false;
    if ((current.cancelledQuantity ?? 0) > 0 || (current.refundedQuantity ?? 0) > 0) return false;
    if ((current.quantity ?? 0) <= 0) return false;

    const authority = deriveOmsLineAuthority({
      sourceTopic: "reconciler/authorize",
      sourceEventId: SOURCE_EVENT_ID,
      sourceInboxId: null,
      financialStatus: "paid",
      quantity: current.quantity,
      fulfillableQuantity: current.fulfillableQuantity ?? null,
      previous: current,
    });

    await tx
      .update(omsOrderLines)
      .set({
        channelObservedQuantity: authority.channelObservedQuantity,
        paidQuantity: authority.paidQuantity,
        authorityFulfillableQuantity: authority.authorityFulfillableQuantity,
        authorizationStatus: authority.authorizationStatus,
        authorizedAt: authority.authorizedAt,
        authorizedByEventId: authority.authorizedByEventId,
        authoritySourceTopic: authority.authoritySourceTopic,
        authoritySourceInboxId: authority.authoritySourceInboxId,
      })
      .where(eq(omsOrderLines.id, lineId));

    await recordOmsLineAuthorityEvent({
      db: tx,
      orderId: omsOrderId,
      orderLineId: lineId,
      eventType: "line_updated",
      sourceEventId: SOURCE_EVENT_ID,
      previous: current,
      authority,
    });
    return true;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[RecoverUnauthorized] ${opts.apply ? "APPLY" : "DRY-RUN"} — scanning for paid-but-unauthorized shippable lines` +
      (opts.order ? ` (order ${opts.order})` : "") + "...",
  );

  const affected = await findAffectedLines(opts);
  if (affected.length === 0) {
    console.log("[RecoverUnauthorized] No affected lines found. Nothing to do.");
    return;
  }

  // Group by OMS order.
  const byOrder = new Map<number, AffectedLine[]>();
  for (const line of affected) {
    const lines = byOrder.get(line.omsOrderId) ?? [];
    lines.push(line);
    byOrder.set(line.omsOrderId, lines);
  }

  console.log(`[RecoverUnauthorized] ${affected.length} stuck line(s) across ${byOrder.size} order(s):\n`);
  for (const [omsOrderId, lines] of byOrder) {
    const label = lines[0].externalOrderNumber ?? `oms ${omsOrderId}`;
    console.log(`  ${label} (oms ${omsOrderId}) — ${lines.length} line(s):`);
    for (const l of lines) console.log(`      ${l.sku} x${l.quantity} (line ${l.lineId})`);
  }

  if (!opts.apply) {
    console.log(`\n[RecoverUnauthorized] DRY-RUN complete. Re-run with --apply to re-authorize + re-sync + push.`);
    return;
  }

  const services = createServices(db);
  const wmsSync: any = (services as any).wmsSync;
  if (!wmsSync?.syncOmsOrderToWms) {
    console.error("[RecoverUnauthorized] wmsSync.syncOmsOrderToWms unavailable — aborting.");
    return;
  }

  let authorized = 0;
  let ordersResynced = 0;
  let ordersStillStuck = 0;
  for (const [omsOrderId, lines] of byOrder) {
    const label = lines[0].externalOrderNumber ?? `oms ${omsOrderId}`;
    let authorizedThisOrder = 0;
    for (const l of lines) {
      try {
        if (await reauthorizeLine(omsOrderId, l.lineId)) {
          authorized++;
          authorizedThisOrder++;
        }
      } catch (err: any) {
        console.error(`[RecoverUnauthorized] re-authorize failed for ${label} line ${l.lineId}: ${err?.message}`);
      }
    }
    if (authorizedThisOrder === 0) {
      console.warn(`[RecoverUnauthorized] ${label}: no lines re-authorized (already changed); skipping re-sync.`);
      continue;
    }
    try {
      await wmsSync.syncOmsOrderToWms(omsOrderId);
      ordersResynced++;
    } catch (err: any) {
      console.error(`[RecoverUnauthorized] re-sync failed for ${label} (oms ${omsOrderId}): ${err?.message}`);
    }

    // Verify: any lines still stuck for this order after re-sync?
    const check: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM oms.oms_order_lines l
      WHERE l.order_id = ${omsOrderId}
        AND l.requires_shipping = true
        AND l.quantity > 0
        AND COALESCE(l.cancelled_quantity,0) = 0
        AND COALESCE(l.refunded_quantity,0) = 0
        AND COALESCE(l.wms_materialized_quantity,0) < l.quantity
    `);
    const stillStuck = Number(check?.rows?.[0]?.n ?? 0);
    if (stillStuck > 0) {
      ordersStillStuck++;
      console.warn(`[RecoverUnauthorized] ${label}: ${stillStuck} line(s) STILL not materialized after re-sync — needs manual review.`);
    } else {
      console.log(`[RecoverUnauthorized] ${label}: recovered (${authorizedThisOrder} line(s) authorized + materialized).`);
    }
  }

  console.log(
    `\n[RecoverUnauthorized] APPLY complete: re-authorized ${authorized} line(s), re-synced ${ordersResynced}/${byOrder.size} order(s)` +
      (ordersStillStuck > 0 ? `, ${ordersStillStuck} order(s) still need manual review` : "") +
      ". Re-run without --apply to verify zero remaining.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[RecoverUnauthorized] Fatal:", err);
    process.exit(1);
  });
