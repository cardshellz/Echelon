import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  MarketplaceCancelStopCandidate,
  MarketplaceCancelStopRecord,
  MarketplaceCancelStopRecorded,
  MarketplaceOrderCancelRepository,
} from "../application/dropship-marketplace-order-cancel-service";
import { DropshipError } from "../domain/errors";
import {
  decideAcceptedCancelOutcome,
  decideMarketplaceCancel,
  MARKETPLACE_CANCEL_REFUND_REFERENCE_TYPES,
  MARKETPLACE_CANCEL_STATUSES,
  marketplaceCancelCreditKey,
  marketplaceCancelRewardsCreditKey,
  marketplaceCancelSubjectKey,
  planMarketplaceCancelRefund,
  type AcceptedCancelOutcome,
  type MarketplaceCancelAction,
  type MarketplaceCancelRefundPlan,
  type MarketplaceCancelStopKind,
} from "../domain/marketplace-order-cancel";
import { marketplaceSyncNotice, type MarketplaceSyncNoticeIntent } from "../domain/marketplace-sync-decision";
import type { OrderProcessingFailureDecision } from "../domain/order-processing-retry";
import { markMarketplaceSaleOrderCancelledWithClient } from "./dropship-listing-marketplace-sales.repository";
import { enqueueMarketplaceSyncNoticesWithClient } from "./dropship-marketplace-sync-notices.repository";
import { reconcileRewardsLotsWithClient, restoreRewardsToLotsWithClient } from "./dropship-wallet-rewards-lots";

/**
 * eBay cancellations of dropship orders already taken in (plan v4 §7.2):
 * the intake side of an eBay cancel, and the dropship side of OMS's answer
 * for an accepted one, with the refund of a stopped order. Every write is
 * one transaction with the intake row locked FOR UPDATE, and every audit row
 * and vendor notice commits with its change. Replays are no-ops: the intake
 * flags are compare-and-set, the refund rows carry unique keys
 * (dropship_wallet_idem_idx, dropship_wallet_ref_idx) and the notices unique
 * subjects. Money is integer cents.
 */

/** Who writes: the eBay order poll, or the order-processing worker. */
export interface MarketplaceCancelActor { actorType: "system" | "job"; actorId: string | null }

const NEVER_CHARGED_STATUSES = ["received", "retrying", "failed", "payment_hold", "exception"] as const;
/** // PROPOSED (sync-back): the reason an intake shows when eBay cancelled it before Card Shellz accepted it (staff and vendor order pages). */
const CANCELLED_ON_MARKETPLACE_REASON = "Cancelled on eBay before Card Shellz accepted it.";
const REFUND_CASH_REFERENCE_TYPE = MARKETPLACE_CANCEL_REFUND_REFERENCE_TYPES.cash;
const REFUND_REWARDS_REFERENCE_TYPE = MARKETPLACE_CANCEL_REFUND_REFERENCE_TYPES.rewards;

interface IntakeCancelRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  status: string;
  cancellation_status: string | null;
  marketplace_cancelled_at: Date | null;
  oms_order_id: string | number | null;
  external_order_id: string;
  external_order_number: string | null;
  stage_state: string | null;
}

const INTAKE_CANCEL_COLUMNS = `oi.id, oi.vendor_id, oi.store_connection_id, oi.status, oi.cancellation_status, oi.marketplace_cancelled_at,
  oi.oms_order_id, oi.external_order_id, oi.external_order_number,
  (SELECT s.state FROM dropship.dropship_order_acceptance_stages s WHERE s.intake_id = oi.id) AS stage_state`;

export interface AppliedMarketplaceCancel {
  /** What the cancel did; `no_intake` when Card Shellz never took the order in. */
  action: MarketplaceCancelAction["kind"] | "no_intake";
  intakeId: number | null;
  /** Sales-ledger lines of the order now marked cancelled (§6.4). */
  saleLinesCancelled: number;
}

/**
 * Applies one eBay cancellation the poll saw (plan v2 §7.2 intake table), in
 * one transaction: the order's sales-ledger lines stop counting as live
 * sales, then the intake (if any) is cancelled, flagged for processing, or
 * sent to OMS to be stopped. A replay finds the flag set and writes nothing.
 */
export async function applyMarketplaceCancellationWithClient(client: PoolClient, input: {
  storeConnectionId: number; externalOrderId: string; at: Date; actor: MarketplaceCancelActor;
}): Promise<AppliedMarketplaceCancel> {
  const saleLinesCancelled = await markMarketplaceSaleOrderCancelledWithClient(client, {
    storeConnectionId: input.storeConnectionId, externalOrderId: input.externalOrderId, cancelledAt: input.at,
  });
  const result = await client.query<IntakeCancelRow>(`SELECT ${INTAKE_CANCEL_COLUMNS}
    FROM dropship.dropship_order_intake oi WHERE oi.store_connection_id = $1 AND oi.external_order_id = $2 FOR UPDATE OF oi`,
  [input.storeConnectionId, input.externalOrderId]);
  const row = result.rows[0];
  if (!row) return { action: "no_intake", intakeId: null, saleLinesCancelled };
  const action = decideMarketplaceCancel({
    status: row.status, cancellationStatus: row.cancellation_status, marketplaceCancelledAt: row.marketplace_cancelled_at, stageState: row.stage_state,
  });
  switch (action.kind) {
    case "already_applied":
    case "nothing_to_do":
      break;
    case "outbound_cancel_unneeded":
      await updateWithAudit(client, row, input, {
        sql: `UPDATE dropship.dropship_order_intake SET cancellation_status = $3, marketplace_cancelled_at = COALESCE(marketplace_cancelled_at, $2),
            updated_at = $2 WHERE id = $1 AND cancellation_status IS NOT DISTINCT FROM $4`,
        params: [MARKETPLACE_CANCEL_STATUSES.marketplaceCancelled, row.cancellation_status],
        eventType: "order_outbound_cancel_done_by_marketplace",
        after: { status: row.status, cancellationStatus: MARKETPLACE_CANCEL_STATUSES.marketplaceCancelled },
      });
      break;
    case "cancel_intake":
      await cancelIntakeOnMarketplaceWithClient(client, { intakeId: row.id, at: input.at, actor: input.actor });
      break;
    case "flag_for_processing":
      // Due now: the processing claim cancels it once nothing is held (canCancelFlaggedIntakeAtClaim).
      await updateWithAudit(client, row, input, {
        sql: `UPDATE dropship.dropship_order_intake SET marketplace_cancelled_at = $2, next_processing_attempt_at = $2, updated_at = $2
          WHERE id = $1 AND marketplace_cancelled_at IS NULL AND status = $3`,
        params: [row.status],
        eventType: "order_marketplace_cancel_flagged",
        after: { status: row.status, cancellationStatus: row.cancellation_status, marketplaceCancelled: true },
      });
      break;
    case "stop_accepted":
      // The stop's own attempts reuse the processing count and due time (an accepted intake is never processed again).
      await updateWithAudit(client, row, input, {
        sql: `UPDATE dropship.dropship_order_intake SET marketplace_cancelled_at = $2, cancellation_status = $3, processing_attempt_count = 0,
            next_processing_attempt_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'accepted' AND marketplace_cancelled_at IS NULL`,
        params: [MARKETPLACE_CANCEL_STATUSES.stopPending],
        eventType: "order_marketplace_cancel_stop_requested",
        after: { status: row.status, cancellationStatus: MARKETPLACE_CANCEL_STATUSES.stopPending },
      });
      break;
  }
  return { action: action.kind, intakeId: row.id, saleLinesCancelled };
}

/**
 * Cancels a never-charged intake eBay cancelled (status `cancelled`,
 * `cancelled_on_marketplace`): guarded on a never-charged status, with its
 * audit row. Answers whether this call cancelled it. Finance counts it as
 * never charged (dropship-finance-sql.ts, the no-debit branch).
 */
export async function cancelIntakeOnMarketplaceWithClient(client: Pick<PoolClient, "query">, input: {
  intakeId: number; at: Date; actor: MarketplaceCancelActor;
}): Promise<boolean> {
  const updated = await client.query<{ vendor_id: number; store_connection_id: number; external_order_id: string; before_status: string }>(`
    UPDATE dropship.dropship_order_intake oi
    SET status = 'cancelled', cancellation_status = $3, rejection_reason = $4,
        marketplace_cancelled_at = COALESCE(oi.marketplace_cancelled_at, $2), next_processing_attempt_at = NULL, updated_at = $2
    FROM dropship.dropship_order_intake before
    WHERE oi.id = $1 AND before.id = oi.id AND oi.status = ANY($5::varchar[])
    RETURNING oi.vendor_id, oi.store_connection_id, oi.external_order_id, before.status AS before_status`,
  [input.intakeId, input.at, MARKETPLACE_CANCEL_STATUSES.cancelledOnMarketplace, CANCELLED_ON_MARKETPLACE_REASON, [...NEVER_CHARGED_STATUSES]]);
  const row = updated.rows[0];
  if (!row) return false;
  await insertIntakeAudit(client, {
    vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, intakeId: input.intakeId, eventType: "order_cancelled_on_marketplace",
    actor: input.actor, severity: "info", at: input.at,
    payload: { externalOrderId: row.external_order_id, before: { status: row.before_status },
      after: { status: "cancelled", cancellationStatus: MARKETPLACE_CANCEL_STATUSES.cancelledOnMarketplace } },
  });
  return true;
}

export class PgDropshipMarketplaceOrderCancelRepository implements MarketplaceOrderCancelRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  /**
   * Accepted orders eBay cancelled whose stop is due, oldest first. An
   * intake flagged while it was being processed and then accepted counts as
   * well (flag set, no cancellation status yet).
   */
  async listDueStops(input: { now: Date; limit: number }): Promise<MarketplaceCancelStopCandidate[]> {
    const result = await this.dbPool.query<{
      id: number; vendor_id: number; store_connection_id: number; oms_order_id: string | number | null; external_order_id: string;
      external_order_number: string | null; processing_attempt_count: number;
    }>(`SELECT id, vendor_id, store_connection_id, oms_order_id, external_order_id, external_order_number, processing_attempt_count
      FROM dropship.dropship_order_intake
      WHERE status = 'accepted' AND marketplace_cancelled_at IS NOT NULL
        AND (cancellation_status IS NULL OR cancellation_status = $3)
        AND (next_processing_attempt_at IS NULL OR next_processing_attempt_at <= $1)
      ORDER BY COALESCE(next_processing_attempt_at, marketplace_cancelled_at), id
      LIMIT $2`, [input.now, input.limit, MARKETPLACE_CANCEL_STATUSES.stopPending]);
    return result.rows.map((row) => ({
      intakeId: row.id, vendorId: row.vendor_id, storeConnectionId: row.store_connection_id,
      omsOrderId: row.oms_order_id === null ? null : safeId(row.oms_order_id, "oms_order_id"), externalOrderId: row.external_order_id,
      externalOrderNumber: row.external_order_number, attemptCount: row.processing_attempt_count,
    }));
  }

  /**
   * Records OMS's answer in one transaction: a stopped order's refund (cash
   * with the advance fee, points to their lots), the new cancellation status,
   * the audit row and the vendor notice. Guarded on the stop still pending.
   */
  async recordStopOutcome(input: MarketplaceCancelStopRecord): Promise<MarketplaceCancelStopRecorded> {
    return this.inTransaction(async (client) => {
      const row = await lockPendingStop(client, input.candidate.intakeId);
      if (!row) return { applied: false };
      const refund = input.outcome.refund ? await postMarketplaceCancelRefundWithClient(client, { intakeId: row.id, vendorId: row.vendor_id, at: input.at })
        : null;
      await client.query(`UPDATE dropship.dropship_order_intake SET cancellation_status = $2, next_processing_attempt_at = NULL, updated_at = $3
        WHERE id = $1`, [row.id, input.outcome.cancellationStatus, input.at]);
      await insertIntakeAudit(client, {
        vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, intakeId: row.id, eventType: "order_marketplace_cancel_stop_recorded",
        actor: { actorType: "job", actorId: input.workerId }, severity: input.outcome.requiresReview ? "error" : "info", at: input.at,
        payload: {
          externalOrderId: row.external_order_id, omsOrderId: input.candidate.omsOrderId, verdict: input.kind, shipments: input.shipments,
          requiresReview: input.outcome.requiresReview,
          refund: refund && { cashCents: refund.cashCents, rewardsCents: refund.rewardsCents, orderDebitRefundCents: refund.orderDebitRefundCents,
            advanceFeeRefundCents: refund.advanceFeeRefundCents, replayed: refund.replayed },
          before: { cancellationStatus: row.cancellation_status }, after: { cancellationStatus: input.outcome.cancellationStatus },
        },
      });
      await enqueueOutcomeNotice(client, row, input.outcome, refund, input.at);
      return { applied: true, refund };
    });
  }

  /**
   * A stop attempt that failed: the next attempt's time (§7.1 delays), or,
   * when the attempts ran out or the failure is permanent, review with the
   * not-stopped notice. Guarded on the stop still pending.
   */
  async recordStopFailure(input: {
    candidate: MarketplaceCancelStopCandidate; decision: OrderProcessingFailureDecision; errorCode: string; errorMessage: string; at: Date; workerId: string;
    omsAnswer: MarketplaceCancelStopKind | null;
  }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const row = await lockPendingStop(client, input.candidate.intakeId);
      if (!row) return false;
      const review = input.decision.status === "failed";
      const reviewStatus = input.omsAnswer === "already_shipped" ? MARKETPLACE_CANCEL_STATUSES.afterShipment : MARKETPLACE_CANCEL_STATUSES.review;
      await client.query(`UPDATE dropship.dropship_order_intake SET processing_attempt_count = $2, next_processing_attempt_at = $3,
          cancellation_status = $4, updated_at = $5 WHERE id = $1`,
      [row.id, input.decision.attemptCount, input.decision.nextAttemptAt,
        review ? reviewStatus : MARKETPLACE_CANCEL_STATUSES.stopPending, input.at]);
      await insertIntakeAudit(client, {
        vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, intakeId: row.id,
        eventType: review ? "order_marketplace_cancel_stop_review" : "order_marketplace_cancel_stop_retry_scheduled",
        actor: { actorType: "job", actorId: input.workerId }, severity: review ? "error" : "warning", at: input.at,
        payload: { externalOrderId: row.external_order_id, errorCode: input.errorCode, errorMessage: input.errorMessage.slice(0, 2000),
          attemptCount: input.decision.attemptCount, nextAttemptAt: input.decision.nextAttemptAt?.toISOString() ?? null,
          exhausted: input.decision.exhausted, requiresReview: review, omsAnswer: input.omsAnswer,
          before: { cancellationStatus: row.cancellation_status },
          after: { cancellationStatus: review ? reviewStatus : MARKETPLACE_CANCEL_STATUSES.stopPending } },
      });
      const notice = review ? stopFailureNotice(input.omsAnswer) : null;
      if (notice !== null) {
        await enqueueOutcomeNotice(client, row, { cancellationStatus: reviewStatus, refund: false, notice, requiresReview: true }, null, input.at);
      }
      return true;
    });
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original error is the one to report; a failed rollback ends with the connection.
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * The vendor's notice when a stop goes to review after a failure (review
 * ARCH-7): OMS never answered, so it may have left the warehouse (the
 * not-stopped words); OMS answered, so the words follow its answer. OMS said
 * stopped and only the refund could not be posted: no "left the warehouse"
 * notice, which would be false; staff see it in ops health.
 */
function stopFailureNotice(omsAnswer: MarketplaceCancelStopKind | null): AcceptedCancelOutcome["notice"] {
  if (omsAnswer === null) return { kind: "order_cancel_not_stopped", shipped: false };
  if (omsAnswer === "stopped") return null;
  return decideAcceptedCancelOutcome(omsAnswer).notice;
}

async function lockPendingStop(client: PoolClient, intakeId: number): Promise<IntakeCancelRow | null> {
  const result = await client.query<IntakeCancelRow>(`SELECT ${INTAKE_CANCEL_COLUMNS}
    FROM dropship.dropship_order_intake oi WHERE oi.id = $1 FOR UPDATE OF oi`, [intakeId]);
  const row = result.rows[0];
  if (!row || row.status !== "accepted" || row.marketplace_cancelled_at === null) return null;
  return row.cancellation_status === null || row.cancellation_status === MARKETPLACE_CANCEL_STATUSES.stopPending ? row : null;
}

interface LedgerRow { id: number; type: string; amount_cents: string | number; wallet_account_id: number | null; currency: string }
interface AccountRow { id: number; vendor_id: number; available_balance_cents: string | number; pending_balance_cents: string | number;
  rewards_balance_cents: string | number; currency: string }

/**
 * Gives a stopped order back what its acceptance took (owner Q5: the advance
 * fee too): one `refund_credit` to the cash balance and one
 * `rewards_reinstated` to the points balance (back to the lots the order
 * took them from), each keyed per intake so a replay finds its own row and
 * writes nothing. The account is locked FOR UPDATE; balances change in the
 * same transaction as their ledger rows and audit rows.
 */
export async function postMarketplaceCancelRefundWithClient(client: PoolClient, input: {
  intakeId: number; vendorId: number; at: Date;
}): Promise<MarketplaceCancelRefundPlan & { replayed: boolean }> {
  const debits = await client.query<LedgerRow>(`SELECT id, type, amount_cents, wallet_account_id, currency FROM dropship.dropship_wallet_ledger
    WHERE vendor_id = $1 AND status = 'settled' AND reference_id = $2
      AND ((reference_type = 'order_intake' AND type = 'order_debit') OR (reference_type = 'order_intake_rewards' AND type = 'rewards_spent')
        OR (reference_type = 'order_intake_advance_fee' AND type = 'advance_fee'))
    ORDER BY id`, [input.vendorId, String(input.intakeId)]);
  const byType = new Map<string, LedgerRow>();
  for (const row of debits.rows) {
    if (byType.has(row.type)) throw refundInvalid("The order has more than one debit row of a type.", { intakeId: input.intakeId, type: row.type });
    byType.set(row.type, row);
  }
  const plan = planMarketplaceCancelRefund({
    orderDebitCents: centsOf(byType.get("order_debit")), advanceFeeCents: centsOf(byType.get("advance_fee")),
    rewardsSpentCents: centsOf(byType.get("rewards_spent")),
  });
  const replay = await client.query<{ id: number }>(`SELECT id FROM dropship.dropship_wallet_ledger WHERE idempotency_key = ANY($1::varchar[])`,
    [[marketplaceCancelCreditKey(input.intakeId), marketplaceCancelRewardsCreditKey(input.intakeId)]]);
  if (replay.rows.length > 0) return { ...plan, replayed: true };
  if (plan.cashCents === 0 && plan.rewardsCents === 0) return { ...plan, replayed: false };

  const accountIds = new Set([...byType.values()].map((row) => row.wallet_account_id));
  const currencies = new Set([...byType.values()].map((row) => row.currency));
  if (accountIds.size !== 1 || currencies.size !== 1 || [...accountIds][0] === null) {
    throw refundInvalid("The order's debit rows do not name one wallet account and currency.", { intakeId: input.intakeId });
  }
  const walletAccountId = [...accountIds][0] as number;
  const currency = [...currencies][0] as string;
  // Any account status: the money is the vendor's whether or not the wallet may be spent from now (a return
  // settlement refuses a closed wallet because it is new money; this gives back money the order took).
  const locked = await client.query<AccountRow>(`SELECT id, vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents,
      currency FROM dropship.dropship_wallet_accounts WHERE id = $1 AND vendor_id = $2 FOR UPDATE`, [walletAccountId, input.vendorId]);
  const account = locked.rows[0];
  if (!account || account.currency !== currency) {
    throw refundInvalid("The order's wallet account is missing or holds another currency.", { intakeId: input.intakeId, walletAccountId });
  }
  const before = {
    availableBalanceCents: safeCents(account.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: safeCents(account.pending_balance_cents, "pending_balance_cents"),
    rewardsBalanceCents: safeCents(account.rewards_balance_cents, "rewards_balance_cents"),
  };
  const after = {
    availableBalanceCents: checkedAdd(before.availableBalanceCents, plan.cashCents),
    rewardsBalanceCents: checkedAdd(before.rewardsBalanceCents, plan.rewardsCents),
  };
  if (plan.rewardsCents > 0) {
    // The lots must equal the balance before points go back to them (migration 0705), as every rewards writer does.
    await reconcileRewardsLotsWithClient(client, {
      account: { walletAccountId, vendorId: input.vendorId, rewardsBalanceCents: before.rewardsBalanceCents }, cause: "rewards_reinstated", now: input.at,
    });
  }
  await client.query(`UPDATE dropship.dropship_wallet_accounts SET available_balance_cents = $3, rewards_balance_cents = $4, updated_at = $5
    WHERE id = $1 AND vendor_id = $2`, [walletAccountId, input.vendorId, after.availableBalanceCents, after.rewardsBalanceCents, input.at]);
  const metadata = {
    intakeId: input.intakeId, source: "ebay_marketplace_cancel", orderDebitRefundCents: plan.orderDebitRefundCents,
    advanceFeeRefundCents: plan.advanceFeeRefundCents, rewardsRefundCents: plan.rewardsCents,
    orderDebitLedgerEntryId: byType.get("order_debit")?.id ?? null, advanceFeeLedgerEntryId: byType.get("advance_fee")?.id ?? null,
    rewardsSpentLedgerEntryId: byType.get("rewards_spent")?.id ?? null,
  };
  if (plan.cashCents > 0) {
    const credit = await insertLedger(client, { walletAccountId, vendorId: input.vendorId, type: "refund_credit", amountCents: plan.cashCents, currency,
      availableAfter: after.availableBalanceCents, pendingAfter: before.pendingBalanceCents, rewardsAfter: after.rewardsBalanceCents,
      referenceType: REFUND_CASH_REFERENCE_TYPE, referenceId: String(input.intakeId), idempotencyKey: marketplaceCancelCreditKey(input.intakeId),
      metadata, at: input.at });
    await insertWalletAudit(client, { vendorId: input.vendorId, ledgerEntryId: credit, eventType: "wallet_order_cancel_refunded", at: input.at,
      payload: { ...metadata, walletAccountId, amountCents: plan.cashCents,
        before: { availableBalanceCents: before.availableBalanceCents }, after: { availableBalanceCents: after.availableBalanceCents } } });
  }
  if (plan.rewardsCents > 0) {
    const spent = byType.get("rewards_spent");
    if (!spent) throw refundInvalid("A points refund has no points spend to return to.", { intakeId: input.intakeId });
    const reinstated = await insertLedger(client, { walletAccountId, vendorId: input.vendorId, type: "rewards_reinstated", amountCents: plan.rewardsCents,
      currency, availableAfter: after.availableBalanceCents, pendingAfter: before.pendingBalanceCents, rewardsAfter: after.rewardsBalanceCents,
      referenceType: REFUND_REWARDS_REFERENCE_TYPE, referenceId: String(input.intakeId), idempotencyKey: marketplaceCancelRewardsCreditKey(input.intakeId),
      metadata, at: input.at });
    const restored = await restoreRewardsToLotsWithClient(client, { account: { walletAccountId, vendorId: input.vendorId }, takenByLedgerEntryId: spent.id,
      ledgerEntryId: reinstated, amountCents: plan.rewardsCents, now: input.at });
    await insertWalletAudit(client, { vendorId: input.vendorId, ledgerEntryId: reinstated, eventType: "wallet_order_cancel_rewards_reinstated", at: input.at,
      payload: { ...metadata, walletAccountId, amountCents: plan.rewardsCents, rewardsLotRestores: restored.restores,
        rewardsRestoredLotId: restored.restoredLot?.lotId ?? null,
        before: { rewardsBalanceCents: before.rewardsBalanceCents }, after: { rewardsBalanceCents: after.rewardsBalanceCents } } });
  }
  return { ...plan, replayed: false };
}

async function insertLedger(client: PoolClient, input: {
  walletAccountId: number; vendorId: number; type: "refund_credit" | "rewards_reinstated"; amountCents: number; currency: string;
  availableAfter: number; pendingAfter: number; rewardsAfter: number; referenceType: string; referenceId: string; idempotencyKey: string;
  metadata: Record<string, unknown>; at: Date;
}): Promise<number> {
  const result = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency, available_balance_after_cents, pending_balance_after_cents,
       rewards_balance_after_cents, reference_type, reference_id, idempotency_key, metadata, created_at, settled_at)
    VALUES ($1, $2, $3, 'settled', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13) RETURNING id`,
  [input.walletAccountId, input.vendorId, input.type, input.amountCents, input.currency, input.availableAfter, input.pendingAfter, input.rewardsAfter,
    input.referenceType, input.referenceId, input.idempotencyKey, JSON.stringify(input.metadata), input.at]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw refundInvalid("A refund ledger row was not recorded.", { type: input.type });
  return id;
}

async function insertWalletAudit(client: PoolClient, input: {
  vendorId: number; ledgerEntryId: number; eventType: string; payload: Record<string, unknown>; at: Date;
}): Promise<void> {
  await client.query(`INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, 'dropship_wallet_ledger', $2, $3, 'system', NULL, 'info', $4::jsonb, $5)`,
  [input.vendorId, String(input.ledgerEntryId), input.eventType, JSON.stringify(input.payload), input.at]);
}

async function updateWithAudit(client: PoolClient, row: IntakeCancelRow, input: { at: Date; actor: MarketplaceCancelActor }, change: {
  sql: string; params: unknown[]; eventType: string; after: Record<string, unknown>;
}): Promise<void> {
  const updated = await client.query(change.sql, [row.id, input.at, ...change.params]);
  if (updated.rowCount !== 1) return;
  await insertIntakeAudit(client, {
    vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, intakeId: row.id, eventType: change.eventType, actor: input.actor,
    severity: "info", at: input.at,
    payload: { externalOrderId: row.external_order_id, before: { status: row.status, cancellationStatus: row.cancellation_status }, after: change.after },
  });
}

async function insertIntakeAudit(client: Pick<PoolClient, "query">, input: {
  vendorId: number; storeConnectionId: number; intakeId: number; eventType: string; actor: MarketplaceCancelActor;
  severity: "info" | "warning" | "error"; payload: Record<string, unknown>; at: Date;
}): Promise<void> {
  await client.query(`INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, $2, 'dropship_order_intake', $3, $4, $5, $6, $7, $8::jsonb, $9)`,
  [input.vendorId, input.storeConnectionId, String(input.intakeId), input.eventType, input.actor.actorType, input.actor.actorId, input.severity,
    JSON.stringify(input.payload), input.at]);
}

/** The vendor notice of a stop's outcome (rule 7d), in the outcome's own transaction; once per intake and kind. */
async function enqueueOutcomeNotice(client: PoolClient, row: IntakeCancelRow, outcome: AcceptedCancelOutcome,
  refund: MarketplaceCancelRefundPlan | null, at: Date): Promise<void> {
  if (!outcome.notice) return;
  const facts = { intakeId: row.id, externalOrderId: row.external_order_id, externalOrderNumber: row.external_order_number ?? row.external_order_id };
  const notice: MarketplaceSyncNoticeIntent = outcome.notice.kind === "order_cancel_refunded"
    ? marketplaceSyncNotice("order_cancel_refunded", marketplaceCancelSubjectKey(row.id), {
      ...facts, cashRefundCents: refund?.cashCents ?? 0, advanceFeeRefundCents: refund?.advanceFeeRefundCents ?? 0, rewardsRefundCents: refund?.rewardsCents ?? 0,
    })
    : marketplaceSyncNotice("order_cancel_not_stopped", marketplaceCancelSubjectKey(row.id), { ...facts, shipped: outcome.notice.shipped });
  await enqueueMarketplaceSyncNoticesWithClient(client, { vendorId: row.vendor_id, storeConnectionId: row.store_connection_id, notices: [notice], createdAt: at });
}

function centsOf(row: LedgerRow | undefined): number | null {
  return row ? safeCents(row.amount_cents, `${row.type}.amount_cents`) : null;
}

function safeCents(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw refundInvalid("A wallet amount is not a safe whole number of cents.", { field });
  return parsed;
}

function safeId(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw refundInvalid("An id is not a positive safe integer.", { field });
  return parsed;
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw refundInvalid("A wallet balance would leave the safe integer range.", {});
  return sum;
}

/** The ledger or account does not support a refund as recorded: permanent, a person reviews (never retried as is). */
function refundInvalid(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_REFUND_INVALID", message, { ...context, classification: "permanent", retryable: false });
}
