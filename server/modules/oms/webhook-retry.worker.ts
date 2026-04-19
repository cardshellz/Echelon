import { db } from "../../db";
import { webhookRetryQueue } from "@shared/schema";
import { eq, lte, and, sql } from "drizzle-orm";

const MAX_ATTEMPTS = 5;
const LOG_PREFIX = "[Webhook DLQ Worker]";

/**
 * Polls the webhook_retry_queue for pending items that are due for a retry.
 */
export async function startWebhookRetryWorker() {
  console.log(`${LOG_PREFIX} Started background webhook retry worker`);

  setInterval(async () => {
    try {
      await processPendingWebhooks();
    } catch (err) {
      console.error(`${LOG_PREFIX} Error in worker loop:`, err);
    }
  }, 60 * 1000); // Check every minute
}

async function processPendingWebhooks() {
  const pending = await db
    .select()
    .from(webhookRetryQueue)
    .where(
      and(
        eq(webhookRetryQueue.status, "pending"),
        lte(webhookRetryQueue.nextRetryAt, new Date())
      )
    )
    .limit(50); // process in chunks

  if (pending.length === 0) return;

  console.log(`${LOG_PREFIX} Found ${pending.length} pending webhook(s) to retry`);

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
     console.error(`${LOG_PREFIX} Missing SESSION_SECRET, cannot run loopbacks`);
     return;
  }

  for (const item of pending) {
    try {
      console.log(`${LOG_PREFIX} Retrying item ${item.id} (${item.topic}), attempt ${item.attempts + 1}`);

      // Forward to local API
      const url = `http://127.0.0.1:${process.env.PORT || 5000}/api/oms/webhooks/${item.topic}`;
      
      const payloadDomain = (item.payload as any)?.shop_domain || process.env.SHOPIFY_SHOP_DOMAIN || "echelon-wms.myshopify.com";

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-retry": secret,
          "x-shopify-shop-domain": payloadDomain,
        },
        body: JSON.stringify(item.payload),
      });

      if (res.ok) {
        // Success! Mark as done
        await db
          .update(webhookRetryQueue)
          .set({ status: "success", updatedAt: new Date() })
          .where(eq(webhookRetryQueue.id, item.id));
        console.log(`${LOG_PREFIX} Item ${item.id} succeeded`);
      } else {
        // Still failed
        throw new Error(`Local API returned ${res.status}`);
      }
    } catch (itemErr: any) {
      const attempts = item.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? "dead" : "pending";
      
      // Exponential backoff: 2^attempts minutes. (1: 2m, 2: 4m, 3: 8m...)
      const delayMinutes = Math.pow(2, attempts);
      const nextRetryAt = new Date(Date.now() + delayMinutes * 60000);

      await db
        .update(webhookRetryQueue)
        .set({
          attempts,
          status,
          nextRetryAt,
          lastError: itemErr.message || String(itemErr),
          updatedAt: new Date(),
        })
        .where(eq(webhookRetryQueue.id, item.id));

      if (status === "dead") {
        console.error(`${LOG_PREFIX} Item ${item.id} moved to DLQ (dead letter) after ${attempts} attempts`);
        // TODO: Fire an alert or slack notification here in the future
      } else {
        console.warn(`${LOG_PREFIX} Item ${item.id} failed again. Next retry at ${nextRetryAt.toISOString()}`);
      }
    }
  }
}
