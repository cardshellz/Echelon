// subscription.scheduler.ts — Daily billing scheduler (cron)
// Critical: Shopify does NOT auto-bill. We must trigger billing.
import * as storage from "./infrastructure/subscription.repository";
import { createBillingAttempt } from "./infrastructure/shopify.adapter";

const BATCH_DELAY_MS = 500; // 500ms between billing attempts to respect rate limits

/**
 * Process all subscriptions due for billing.
 * Should run daily at 6am ET (11:00 UTC) or on an hourly schedule.
 */
export async function processDueBillings(): Promise<{ processed: number; succeeded: number; failed: number; errors: string[] }> {
  const due = await storage.getDueBillings();
  const errors: string[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  console.log(`[BillingScheduler] Found ${due.length} subscriptions due for billing`);

  for (const sub of due) {
    try {
      if (!sub.shopify_subscription_contract_gid) {
        console.warn(`[BillingScheduler] Subscription ${sub.id} has no contract GID, skipping`);
        continue;
      }

      // Mark billing in progress
      await storage.setBillingInProgress(sub.id, true);

      // Build idempotency key from contract ID + billing date
      const billingDate = sub.next_billing_date
        ? new Date(sub.next_billing_date).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
      const idempotencyKey = `billing-${sub.shopify_subscription_contract_id}-${billingDate}`;

      const originTime = sub.next_billing_date || new Date();

      await createBillingAttempt(
        sub.shopify_subscription_contract_gid,
        idempotencyKey,
        new Date(originTime).toISOString()
      );

      // Billing attempt created — result comes back via webhook
      // Don't update billing date here; wait for success/failure webhook
      await storage.insertBillingLog({
        member_subscription_id: sub.id,
        amount_cents: (sub as any).price_cents || 0,
        status: "pending",
        idempotency_key: idempotencyKey,
      });

      succeeded++;
      console.log(`[BillingScheduler] Initiated billing for subscription ${sub.id} (contract ${sub.shopify_subscription_contract_id})`);
    } catch (err: any) {
      failed++;
      const errMsg = `Subscription ${sub.id}: ${err.message}`;
      errors.push(errMsg);
      console.error(`[BillingScheduler] Error: ${errMsg}`);

      // Clear billing in progress so it can retry next run
      await storage.setBillingInProgress(sub.id, false);
    }

    processed++;

    // Rate limit between attempts
    if (processed < due.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`[BillingScheduler] Complete: processed=${processed} succeeded=${succeeded} failed=${failed}`);

  return { processed, succeeded, failed, errors };
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
      await processDueBillings();
    } catch (err: any) {
      console.error(`[BillingScheduler] Startup run error: ${err.message}`);
    }

    // Then run every hour
    setInterval(async () => {
      try {
        await processDueBillings();
      } catch (err: any) {
        console.error(`[BillingScheduler] Scheduled run error: ${err.message}`);
      }
    }, INTERVAL_MS);

    console.log("[BillingScheduler] Billing scheduler started (runs every hour)");
  }, 2 * 60 * 1000);
}
