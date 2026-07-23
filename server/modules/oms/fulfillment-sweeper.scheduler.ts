import { db } from "../../db";
import { sql, eq, and, gt, lt, inArray } from "drizzle-orm";
import { omsOrders, channels } from "@shared/schema";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { EbayFulfillmentReconciler } from "./reconcilers/ebay.reconciler";
import { ShopifyFulfillmentReconciler } from "./reconcilers/shopify.reconciler";
import type { FulfillmentReconciler } from "./reconcilers/reconciler.interface";
import type { ChannelFulfillmentIngressService } from "./channel-fulfillment-ingress.service";
import type { ChannelFulfillmentAuthorityService } from "./channel-fulfillment-authority.service";
import type { ShipStationPhysicalRecoveryService } from "./shipstation-physical-recovery.service";
import { findChannelWritebackCandidates } from "./channel-writeback.service";
import { resolveRecoveredShipNotifyNoMatchExceptions } from "./ship-notify-reconciliation.service";

const LOG_PREFIX = "[Fulfillment Sweeper]";
const OUTBOUND_SWEEP_LIMIT = 500;
const OUTBOUND_RECENT_SWEEP_LIMIT = 400;
const OUTBOUND_RECENT_WINDOW_DAYS = 30;

export interface RecoveredShopifyWritebackDebtResult {
  retryRowsResolved: number;
  inboxRowsResolved: number;
  reviewMarkersCleared: number;
}

function nonNegativeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Close only the retry/review debt owned by Shopify fulfillment writeback.
 * Other shipment review reasons are intentionally preserved.
 */
export async function resolveRecoveredShopifyWritebackDebt(
  dbArg: any,
  shipmentId: number,
): Promise<RecoveredShopifyWritebackDebtResult> {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new Error(`shipmentId must be a positive integer (got ${shipmentId})`);
  }

  const resolveInTransaction = async (tx: any): Promise<RecoveredShopifyWritebackDebtResult> => {
    const retryResult = await tx.execute(sql`
      WITH resolved_retry AS (
        UPDATE oms.webhook_retry_queue
        SET status = 'success',
            last_error = NULL,
            updated_at = NOW()
        WHERE provider = 'internal'
          AND topic = 'shopify_fulfillment_push'
          AND payload->>'shipmentId' = ${String(shipmentId)}
          AND status <> 'success'
        RETURNING source_inbox_id
      ), resolved_inbox AS (
        UPDATE oms.webhook_inbox wi
        SET status = 'succeeded',
            last_error = NULL,
            processed_at = COALESCE(wi.processed_at, NOW()),
            updated_at = NOW()
        WHERE wi.id IN (
          SELECT source_inbox_id
          FROM resolved_retry
          WHERE source_inbox_id IS NOT NULL
        )
        RETURNING wi.id
      )
      SELECT
        (SELECT COUNT(*)::int FROM resolved_retry) AS retry_rows_resolved,
        (SELECT COUNT(*)::int FROM resolved_inbox) AS inbox_rows_resolved
    `);

    const reviewResult = await tx.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = false,
          review_reason = NULL,
          updated_at = NOW()
      WHERE id = ${shipmentId}
        AND requires_review = true
        AND review_reason LIKE 'permanent_fulfillment_push_failure:%'
      RETURNING id
    `);

    const retryRow = retryResult?.rows?.[0] ?? {};
    return {
      retryRowsResolved: nonNegativeCount(retryRow.retry_rows_resolved),
      inboxRowsResolved: nonNegativeCount(retryRow.inbox_rows_resolved),
      reviewMarkersCleared: Array.isArray(reviewResult?.rows) ? reviewResult.rows.length : 0,
    };
  };

  if (typeof dbArg?.transaction === "function") {
    return dbArg.transaction(resolveInTransaction);
  }
  return resolveInTransaction(dbArg);
}

function getReconciler(
  provider: string,
  dbArg: any,
  fulfillmentAuthority: ChannelFulfillmentAuthorityService,
  channelFulfillmentIngress: ChannelFulfillmentIngressService | null,
): FulfillmentReconciler | null {
  if (provider === "ebay") {
    return new EbayFulfillmentReconciler(dbArg, fulfillmentAuthority, channelFulfillmentIngress);
  }
  if (provider === "shopify") {
    return new ShopifyFulfillmentReconciler(
      dbArg,
      fulfillmentAuthority,
      undefined,
      channelFulfillmentIngress,
    );
  }
  // Dropship reconciler can be added here
  return null;
}

export async function runFulfillmentSweep(
  dbArg: any,
  fulfillmentAuthority: ChannelFulfillmentAuthorityService,
  physicalRecovery: ShipStationPhysicalRecoveryService | null = null,
) {
  try {
    console.log(`${LOG_PREFIX} Starting hourly outbound channel writeback sweep...`);

    try {
      const recovery = await resolveRecoveredShipNotifyNoMatchExceptions(dbArg, {
        limit: 1_000,
        resolvedBy: "system:fulfillment_sweeper",
      });
      if (recovery.resolvedCount > 0) {
        console.log(
          `${LOG_PREFIX} Auto-resolved ${recovery.resolvedCount} recovered SHIP_NOTIFY no-match exception(s).`,
        );
      }
    } catch (error: any) {
      // Channel writeback repair remains independent from exception cleanup.
      // A cleanup failure is observable and retried on the next sweep without
      // blocking customer tracking repairs.
      console.error(
        `${LOG_PREFIX} SHIP_NOTIFY exception recovery failed: ${error?.message ?? String(error)}`,
      );
    }

    // Recover labels that ShipStation combined under a sibling order before
    // the ordinary channel-writeback scan runs. This does not mutate
    // fulfillment directly: it only enqueues the canonical SHIP_NOTIFY path,
    // which revalidates provider item identity and applies the existing
    // idempotent shipment/inventory/channel cascade.
    if (physicalRecovery?.recover) {
      try {
        const result = await physicalRecovery.recover({
          mode: "execute",
          limit: 10,
          minAgeHours: 6,
          maxAgeDays: 30,
        });
        if (result.matchedPackages > 0 || result.errors > 0) {
          console.log(
            `${LOG_PREFIX} ShipStation physical recovery: ${JSON.stringify({
              candidates: result.candidates,
              matchedPackages: result.matchedPackages,
              enqueueRequests: result.enqueueRequests,
              noMatch: result.noMatch,
              errors: result.errors,
            })}`,
          );
        }
      } catch (error: any) {
        console.error(
          `${LOG_PREFIX} ShipStation physical recovery failed: ${error?.message ?? String(error)}`,
        );
      }
    }

    // Shipment scope is required here: an order can be partially shipped, and
    // one successful sibling must never hide another missing writeback. Keep
    // independent capacity for recent incidents and historical convergence so
    // neither a large legacy backlog nor a burst of new failures can starve the
    // other lane.
    const recentCandidates = await findChannelWritebackCandidates(dbArg, {
      minAgeMinutes: 60,
      maxAgeDays: OUTBOUND_RECENT_WINDOW_DAYS,
      limit: OUTBOUND_RECENT_SWEEP_LIMIT,
      excludeRetryStates: false,
    });
    const historicalCandidates = await findChannelWritebackCandidates(dbArg, {
      minAgeMinutes: 60,
      maxAgeDays: null,
      limit: OUTBOUND_SWEEP_LIMIT - recentCandidates.length,
      excludeRetryStates: false,
    });
    const candidates = Array.from(
      new Map(
        [...recentCandidates, ...historicalCandidates].map((candidate) => [
          candidate.shipment_id,
          candidate,
        ]),
      ).values(),
    );

    if (candidates.length === 0) {
      console.log(`${LOG_PREFIX} No missing channel writebacks in the sweep window.`);
      return;
    }

    let processed = 0;
    let repushed = 0;
    for (const row of candidates) {
      if (row.pending_retry) {
        continue;
      }

      processed++;
      try {
        const result = await fulfillmentAuthority.ensureLegacyShipment(
          row.shipment_id,
          { executeImmediately: true, source: "fulfillment_sweeper" },
        );
        const commands = result.materialized.channelCommands;
        const terminalBeforeDispatch = commands.filter((command: any) =>
          command.pushStatus === "success" || command.pushStatus === "ignored"
        ).length;
        const terminalDuringDispatch =
          result.dispatch.succeeded + result.dispatch.ignored;
        const succeeded = commands.length > 0
          && terminalBeforeDispatch + terminalDuringDispatch === commands.length;
        if (succeeded) {
          if (row.provider === "shopify") {
            const recovery = await resolveRecoveredShopifyWritebackDebt(dbArg, row.shipment_id);
            if (
              recovery.retryRowsResolved > 0
              || recovery.inboxRowsResolved > 0
              || recovery.reviewMarkersCleared > 0
            ) {
              console.log(
                `${LOG_PREFIX} Resolved Shopify writeback debt for shipment ${row.shipment_id}: ${JSON.stringify(recovery)}`,
              );
            }
          }
          repushed++;
        } else {
          console.error(
            `${LOG_PREFIX} Canonical writeback remains pending for shipment ${row.shipment_id} (${row.provider}, order ${row.order_number ?? row.oms_order_id}): ${JSON.stringify({ commands, dispatch: result.dispatch })}`,
          );
        }
      } catch (err: any) {
        console.error(
          `${LOG_PREFIX} Error materializing shipment ${row.shipment_id} for ${row.provider}: ${err.message}`,
        );
      }
    }

    console.log(`${LOG_PREFIX} Complete. Processed: ${processed}/${candidates.length}, Repushed: ${repushed}`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Critical error during sweep: ${err.message}`);
  }
}

/**
 * Inbound sweep: find WMS orders still awaiting shipment where the channel
 * already reports the order as fulfilled (label bought outside ShipStation).
 * Pulls tracking from the channel and flows it through WMS shipments.
 */
export async function runInboundFulfillmentSweep(
  dbArg: any,
  fulfillmentAuthority: ChannelFulfillmentAuthorityService,
  channelFulfillmentIngress: ChannelFulfillmentIngressService | null = null,
) {
  try {
    console.log(`${LOG_PREFIX} Starting inbound fulfillment sweep...`);

    // Orders that are paid/active in OMS but NOT shipped in WMS — candidates
    // where someone may have bought a label on the channel directly.
    const candidates = await dbArg.execute(sql`
      SELECT o.id, o.external_order_id, o.channel_id, c.provider,
             w.id AS wms_order_id, w.warehouse_status
      FROM oms.oms_orders o
      JOIN channels.channels c ON o.channel_id = c.id
      JOIN wms.orders w ON w.source = 'oms'
        AND w.oms_fulfillment_order_id = o.id::text
      WHERE o.status NOT IN ('shipped', 'cancelled', 'refunded')
        AND w.warehouse_status NOT IN ('shipped', 'cancelled')
        AND o.ordered_at > NOW() - INTERVAL '14 days'
      ORDER BY o.ordered_at DESC
      LIMIT 50
    `);

    if (candidates.rows.length === 0) {
      console.log(`${LOG_PREFIX} No inbound fulfillment candidates found.`);
      return;
    }

    let synced = 0;

    for (const row of candidates.rows) {
      const provider = row.provider;
      const reconciler = getReconciler(
        provider,
        dbArg,
        fulfillmentAuthority,
        channelFulfillmentIngress,
      );
      if (!reconciler) continue;

      try {
        const status = await reconciler.checkStatus(row);
        if (status !== "fulfilled") continue;

        // Channel says fulfilled — enumerate exact provider packages and lines.
        if (provider === "ebay" && reconciler instanceof EbayFulfillmentReconciler) {
          const ok = await reconciler.syncFulfillmentFromChannel(row);
          if (ok) synced++;
        } else if (provider === "shopify" && reconciler instanceof ShopifyFulfillmentReconciler) {
          const ok = await reconciler.syncFulfillmentsFromChannel(row);
          if (ok) synced++;
        }
      } catch (err: any) {
        console.error(
          `${LOG_PREFIX} Error syncing inbound fulfillment for order ${row.id} (${provider}): ${err.message}`,
        );
      }
    }

    console.log(`${LOG_PREFIX} Inbound sweep complete. Synced: ${synced}/${candidates.rows.length} candidates.`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Critical error during inbound sweep: ${err.message}`);
  }
}

export function startFulfillmentSweeper(
  dbArg: any,
  fulfillmentAuthority: ChannelFulfillmentAuthorityService,
  channelFulfillmentIngress: ChannelFulfillmentIngressService | null = null,
  physicalRecovery: ShipStationPhysicalRecoveryService | null = null,
) {
  if (process.env.DISABLE_SCHEDULERS === "true") {
    return;
  }

  console.log(`${LOG_PREFIX} Scheduler started (runs every hour, dyno-safe lock)`);

  const SWEEPER_LOCK_ID = 8484;
  const INBOUND_LOCK_ID = 8485;

  // Run immediately on boot
  setTimeout(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg, fulfillmentAuthority, physicalRecovery);
    }).catch((err) => console.error(`${LOG_PREFIX} Boot run error: ${err.message}`));
  }, 5000);

  // Inbound sweep on boot (staggered)
  setTimeout(() => {
    withAdvisoryLock(INBOUND_LOCK_ID, async () => {
      await runInboundFulfillmentSweep(
        dbArg,
        fulfillmentAuthority,
        channelFulfillmentIngress,
      );
    }).catch((err) => console.error(`${LOG_PREFIX} Inbound boot run error: ${err.message}`));
  }, 15000);

  // Run every 1 hour thereafter
  setInterval(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg, fulfillmentAuthority, physicalRecovery);
    }).catch((err) => console.error(`${LOG_PREFIX} Scheduled run error: ${err.message}`));
  }, 60 * 60 * 1000);

  // Inbound sweep every hour (offset by 30 min from outbound)
  setTimeout(() => {
    setInterval(() => {
      withAdvisoryLock(INBOUND_LOCK_ID, async () => {
        await runInboundFulfillmentSweep(
          dbArg,
          fulfillmentAuthority,
          channelFulfillmentIngress,
        );
      }).catch((err) => console.error(`${LOG_PREFIX} Inbound sweep error: ${err.message}`));
    }, 60 * 60 * 1000);
  }, 30 * 60 * 1000);
}
