// subscription.scheduler.ts — Daily billing scheduler (cron)
// Critical: Shopify does NOT auto-bill. We must trigger billing.
import { db } from "../../db";
import { readIntegerCents } from "@shared/money-read";
import * as storage from "./infrastructure/subscription.repository";
import {
  createBillingAttempt,
  isDefinitiveSubscriptionProviderRejection,
} from "./infrastructure/shopify.adapter";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";

const BATCH_DELAY_MS = 500; // 500ms between billing attempts to respect rate limits
export const BILLING_LOCK_ID = 54321;

export interface BillingPassSummary {
  skipped?: boolean;
  reason?: "billing_lock_held";
  processed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  errors: string[];
}

/**
 * Process all subscriptions due for billing.
 * Should run daily at 6am ET (11:00 UTC) or on an hourly schedule.
 */
export async function processDueBillings(
  options: { batchDelayMs?: number } = {},
): Promise<BillingPassSummary> {
  const delayMs = options.batchDelayMs ?? BATCH_DELAY_MS;

  // First, reconcile memberships (M7)
  const reconcileStats = await storage.reconcileCurrentMemberships();
  console.log(`[BillingScheduler] M7 Reconcile check complete: ${reconcileStats.upserted} members aligned`);

  const due = await storage.getDueBillings();
  const errors: string[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let uncertain = 0;

  console.log(`[BillingScheduler] Found ${due.length} subscriptions due for billing`);

  for (let idx = 0; idx < due.length; idx++) {
    const sub = due[idx];
    if (!sub.shopify_subscription_contract_gid) {
      console.warn(`[BillingScheduler] Subscription ${sub.id} has no contract GID, skipping`);
      continue;
    }

    // Atomically claim billing_in_progress = false -> true so overlapping callers cannot double-dispatch
    const claimed = await storage.claimBillingInProgress(sub.id);
    if (!claimed) {
      console.log(`[BillingScheduler] Subscription ${sub.id} already claimed, skipping`);
      continue;
    }

    const billingDate = sub.next_billing_date
      ? new Date(sub.next_billing_date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];
    const idempotencyKey = `billing-${sub.shopify_subscription_contract_id}-${billingDate}`;
    const originTime = sub.next_billing_date || new Date();
    const rawPriceCents = (sub as { price_cents?: unknown }).price_cents;
    const amountCents =
      rawPriceCents == null
        ? 0
        : readIntegerCents(rawPriceCents, "subscription.price_cents");

    try {
      const attempt = await createBillingAttempt(
        sub.shopify_subscription_contract_gid,
        idempotencyKey,
        new Date(originTime).toISOString(),
      );

      // Billing attempt created — result comes back via webhook.
      // Persist pending billing log and audit event atomically inside a DB transaction.
      await db.transaction(async (tx) => {
        await storage.insertBillingLog(
          {
            member_subscription_id: sub.id,
            shopify_billing_attempt_id: attempt?.id ?? idempotencyKey,
            shopify_order_id: null,
            amount_cents: amountCents,
            status: "pending",
            idempotency_key: idempotencyKey,
          },
          tx,
        );
        await storage.insertEvent(
          {
            member_subscription_id: sub.id,
            shopify_subscription_contract_id: sub.shopify_subscription_contract_id ?? undefined,
            event_type: "billing_scheduled_dispatched",
            event_source: "scheduler",
            payload: { idempotencyKey, attemptId: attempt?.id ?? null },
          },
          tx,
        );
      });

      succeeded++;
      console.log(`[BillingScheduler] Initiated billing for subscription ${sub.id} (contract ${sub.shopify_subscription_contract_id})`);
    } catch (err: any) {
      const errMessage = err instanceof Error ? err.message : String(err);

      if (isDefinitiveSubscriptionProviderRejection(err)) {
        failed++;
        const errMsg = `Subscription ${sub.id}: ${errMessage}`;
        errors.push(errMsg);
        console.error(`[BillingScheduler] Definitive provider rejection: ${errMsg}`);

        await db.transaction(async (tx) => {
          await storage.setBillingInProgress(sub.id, false, tx);
          await storage.insertBillingLog(
            {
              member_subscription_id: sub.id,
              shopify_billing_attempt_id: idempotencyKey,
              shopify_order_id: null,
              amount_cents: amountCents,
              status: "failed",
              error_code: "PROVIDER_REJECTED",
              error_message: errMessage,
              idempotency_key: idempotencyKey,
            },
            tx,
          );
          await storage.insertEvent(
            {
              member_subscription_id: sub.id,
              shopify_subscription_contract_id: sub.shopify_subscription_contract_id ?? undefined,
              event_type: "billing_scheduled_rejected",
              event_source: "scheduler",
              payload: { idempotencyKey },
              notes: errMessage,
            },
            tx,
          );
        });
      } else {
        // Uncertain transport/timeout/5xx outcome: preserve billing_in_progress = true
        // so the next scheduled pass cannot issue a duplicate charge before reconciliation.
        uncertain++;
        const errMsg = `Subscription ${sub.id} (uncertain — locked pending reconciliation): ${errMessage}`;
        errors.push(errMsg);
        console.error(`[BillingScheduler] Uncertain provider outcome: ${errMsg}`);

        await db.transaction(async (tx) => {
          await storage.insertBillingLog(
            {
              member_subscription_id: sub.id,
              shopify_billing_attempt_id: idempotencyKey,
              shopify_order_id: null,
              amount_cents: amountCents,
              status: "pending",
              error_code: "OUTCOME_UNCERTAIN",
              error_message: errMessage,
              idempotency_key: idempotencyKey,
            },
            tx,
          );
          await storage.insertEvent(
            {
              member_subscription_id: sub.id,
              shopify_subscription_contract_id: sub.shopify_subscription_contract_id ?? undefined,
              event_type: "billing_scheduled_uncertain",
              event_source: "scheduler",
              payload: { idempotencyKey, error: errMessage },
              notes: errMsg,
            },
            tx,
          );
        });
      }
    }

    processed++;

    // Rate limit between attempts
    if (delayMs > 0 && idx + 1 < due.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(
    `[BillingScheduler] Complete: processed=${processed} succeeded=${succeeded} failed=${failed} uncertain=${uncertain}`,
  );

  return { skipped: false, processed, succeeded, failed, uncertain, errors };
}

/**
 * Executes `processDueBillings` under the shared Postgres advisory lock so manual
 * admin runs and scheduled hourly passes can never overlap.
 */
export async function runBillingPassWithLock(): Promise<BillingPassSummary> {
  const result = await withAdvisoryLock(BILLING_LOCK_ID, async () => processDueBillings());
  if (result === null) {
    return {
      skipped: true,
      reason: "billing_lock_held",
      processed: 0,
      succeeded: 0,
      failed: 0,
      uncertain: 0,
      errors: [],
    };
  }
  return result;
}

/**
 * Start the billing scheduler.
 * Runs hourly. The main billing window is around 6am ET (11:00 UTC).
 */
export function startBillingScheduler(): void {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run after a 2 minute startup delay
  setTimeout(async () => {
    try {
      await runBillingPassWithLock();
    } catch (err: any) {
      console.error(`[BillingScheduler] Startup run error: ${err.message}`);
    }

    // Then run every hour
    setInterval(async () => {
      try {
        await runBillingPassWithLock();
      } catch (err: any) {
        console.error(`[BillingScheduler] Scheduled run error: ${err.message}`);
      }
    }, INTERVAL_MS);

    console.log("[BillingScheduler] Billing scheduler started (runs every hour, dyno-safe lock)");
  }, 2 * 60 * 1000);
}
