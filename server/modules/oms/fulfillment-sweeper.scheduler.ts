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
import { processShopifyFulfillmentIngress } from "./shopify-fulfillment-ingress.adapter";
import { processEbayFulfillmentIngress } from "./ebay-fulfillment-ingress.adapter";

const LOG_PREFIX = "[Fulfillment Sweeper]";
const OUTBOUND_SWEEP_LIMIT = 500;
const OUTBOUND_RECENT_SWEEP_LIMIT = 400;
const OUTBOUND_RECENT_WINDOW_DAYS = 30;
const INBOUND_RECEIPT_RECOVERY_LIMIT = 100;
const INBOUND_RECEIPT_RECOVERY_MIN_AGE_MINUTES = 5;
const INBOUND_RECEIPT_RECOVERY_MAX_FAILURES = 5;
const INBOUND_RECEIPT_RECOVERY_INTERVAL_MS = 60_000;

type InboundReceiptEventKind = "created" | "updated" | "reconciled";

interface RecoverableInboundReceipt {
  id: number;
  sourceProvider: "shopify" | "ebay";
  sourceChannelId: number | null;
  sourceOrderId: string;
  sourceEventId: string | null;
  sourceInboxId: number | null;
  eventKind: InboundReceiptEventKind;
  source: string;
  rawPayload: unknown;
  correlationId: string | null;
  causationId: string | null;
}

export interface InboundReceiptRecoveryResult {
  candidates: number;
  recovered: number;
  reviewRequired: number;
  failed: number;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function nullablePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function receiptEventKind(value: unknown): InboundReceiptEventKind {
  if (value === "created" || value === "updated" || value === "reconciled") {
    return value;
  }
  throw new Error(`Unsupported channel fulfillment receipt event kind: ${String(value)}`);
}

function recoverableReceipt(row: any): RecoverableInboundReceipt {
  const id = Number(row.id);
  const sourceProvider = String(row.source_provider);
  const sourceOrderId = nullableString(row.source_order_id);
  const source = nullableString(row.source);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid channel fulfillment receipt id: ${String(row.id)}`);
  }
  if (sourceProvider !== "shopify" && sourceProvider !== "ebay") {
    throw new Error(`Unsupported channel fulfillment receipt provider: ${sourceProvider}`);
  }
  if (!sourceOrderId || !source) {
    throw new Error(`Channel fulfillment receipt ${id} is missing immutable source identity`);
  }
  return {
    id,
    sourceProvider,
    sourceChannelId: nullablePositiveInteger(row.source_channel_id),
    sourceOrderId,
    sourceEventId: nullableString(row.source_event_id),
    sourceInboxId: nullablePositiveInteger(row.source_inbox_id),
    eventKind: receiptEventKind(row.event_kind),
    source,
    rawPayload: row.raw_payload ?? {},
    correlationId: nullableString(row.correlation_id),
    causationId: nullableString(row.causation_id),
  };
}

/**
 * Recover receipts stranded by a process crash or transient database/provider
 * failure. The immutable provider payload and original event identity are sent
 * through the same adapters and lease-controlled ingress service as live
 * traffic; this function does not write fulfillment or inventory state itself.
 */
export async function recoverStaleChannelFulfillmentReceipts(
  dbArg: any,
  channelFulfillmentIngress: ChannelFulfillmentIngressService,
  options: {
    limit?: number;
    minAgeMinutes?: number;
    maxRetryFailures?: number;
    /** @deprecated Use maxRetryFailures. Retained for caller compatibility. */
    maxAttempts?: number;
  } = {},
): Promise<InboundReceiptRecoveryResult> {
  const limit = options.limit ?? INBOUND_RECEIPT_RECOVERY_LIMIT;
  const minAgeMinutes = options.minAgeMinutes ?? INBOUND_RECEIPT_RECOVERY_MIN_AGE_MINUTES;
  const maxRetryFailures = options.maxRetryFailures
    ?? options.maxAttempts
    ?? INBOUND_RECEIPT_RECOVERY_MAX_FAILURES;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("Inbound receipt recovery limit must be an integer from 1 through 500");
  }
  if (!Number.isInteger(minAgeMinutes) || minAgeMinutes < 1) {
    throw new Error("Inbound receipt recovery minimum age must be a positive integer");
  }
  if (!Number.isInteger(maxRetryFailures) || maxRetryFailures < 1) {
    throw new Error("Inbound receipt recovery max failures must be a positive integer");
  }

  const result = await dbArg.execute(sql`
    SELECT
      id,
      source_provider,
      source_channel_id,
      source_order_id,
      source_event_id,
      source_inbox_id,
      event_kind,
      source,
      raw_payload,
      correlation_id,
      causation_id
    FROM oms.channel_fulfillment_receipts
    WHERE source_provider IN ('shopify', 'ebay')
      AND retry_failure_count < ${maxRetryFailures}
      AND (
        (
          processing_status = 'pending'
          AND (
            (
              next_retry_at IS NOT NULL
              AND next_retry_at <= NOW()
            )
            OR (
              next_retry_at IS NULL
              AND created_at <= NOW() - make_interval(mins => ${minAgeMinutes})
            )
          )
        )
        OR (
          processing_status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= NOW()
        )
      )
    ORDER BY COALESCE(last_attempt_at, created_at) ASC, id ASC
    LIMIT ${limit}
  `);
  const rows: any[] = Array.isArray(result?.rows) ? result.rows : [];
  let recovered = 0;
  let reviewRequired = 0;
  let failed = 0;

  for (const rawRow of rows) {
    let receiptId: number | null = nullablePositiveInteger(rawRow?.id);
    try {
      const receipt = recoverableReceipt(rawRow);
      receiptId = receipt.id;
      if (receipt.sourceProvider === "shopify") {
        const outcome = await processShopifyFulfillmentIngress(
          channelFulfillmentIngress,
          receipt.rawPayload,
          {
            sourceChannelId: receipt.sourceChannelId,
            sourceEventId: receipt.sourceEventId,
            sourceInboxId: receipt.sourceInboxId,
            eventKind: receipt.eventKind,
            source: receipt.source,
            correlationId: receipt.correlationId,
            causationId: receipt.causationId,
          },
        );
        if (!outcome.actionable || !outcome.result) {
          throw new Error(`Shopify receipt ${receipt.id} is not an actionable fulfillment`);
        }
        if (outcome.result.processingStatus === "review") reviewRequired++;
        else recovered++;
      } else {
        const outcome = await processEbayFulfillmentIngress(
          channelFulfillmentIngress,
          receipt.rawPayload,
          {
            sourceChannelId: receipt.sourceChannelId,
            sourceOrderId: receipt.sourceOrderId,
            sourceEventId: receipt.sourceEventId,
            sourceInboxId: receipt.sourceInboxId,
            source: receipt.source,
            correlationId: receipt.correlationId,
            causationId: receipt.causationId,
          },
        );
        if (outcome.processingStatus === "review") reviewRequired++;
        else recovered++;
      }
    } catch (error: any) {
      failed++;
      console.error(JSON.stringify({
        code: "CHANNEL_FULFILLMENT_RECEIPT_RECOVERY_FAILED",
        receiptId,
        errorCode: typeof error?.code === "string" ? error.code : null,
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const summary = {
    candidates: rows.length,
    recovered,
    reviewRequired,
    failed,
  };
  console.log(JSON.stringify({
    code: "CHANNEL_FULFILLMENT_RECEIPT_RECOVERY_COMPLETED",
    ...summary,
  }));
  return summary;
}

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

export async function runInboundReceiptRecoverySweep(
  dbArg: any,
  channelFulfillmentIngress: ChannelFulfillmentIngressService,
): Promise<InboundReceiptRecoveryResult> {
  try {
    return await recoverStaleChannelFulfillmentReceipts(
      dbArg,
      channelFulfillmentIngress,
    );
  } catch (error: any) {
    console.error(
      `${LOG_PREFIX} Inbound receipt recovery failed: ${error?.message ?? String(error)}`,
    );
    throw error;
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
  const RECEIPT_RECOVERY_LOCK_ID = 8486;

  // Run immediately on boot
  setTimeout(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg, fulfillmentAuthority, physicalRecovery);
    }).catch((err) => console.error(`${LOG_PREFIX} Boot run error: ${err.message}`));
  }, 5000);

  // Recover durable receipts independently from provider polling. The
  // advisory lock prevents multiple web dynos from processing the same batch.
  if (channelFulfillmentIngress) {
    setTimeout(() => {
      withAdvisoryLock(RECEIPT_RECOVERY_LOCK_ID, async () => {
        await runInboundReceiptRecoverySweep(dbArg, channelFulfillmentIngress);
      }).catch((err) => console.error(`${LOG_PREFIX} Receipt boot recovery error: ${err.message}`));
    }, 15000);

    setInterval(() => {
      withAdvisoryLock(RECEIPT_RECOVERY_LOCK_ID, async () => {
        await runInboundReceiptRecoverySweep(dbArg, channelFulfillmentIngress);
      }).catch((err) => console.error(`${LOG_PREFIX} Receipt recovery error: ${err.message}`));
    }, INBOUND_RECEIPT_RECOVERY_INTERVAL_MS);
  }

  // Inbound provider poll on boot (staggered from receipt recovery).
  setTimeout(() => {
    withAdvisoryLock(INBOUND_LOCK_ID, async () => {
      await runInboundFulfillmentSweep(
        dbArg,
        fulfillmentAuthority,
        channelFulfillmentIngress,
      );
    }).catch((err) => console.error(`${LOG_PREFIX} Inbound boot run error: ${err.message}`));
  }, 30000);

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
