import { db as defaultDb } from "../../db";
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

/**
 * Enqueue a SHIP_NOTIFY retry row.
 *
 * Extracted as a helper so the SS webhook handler in server/index.ts and
 * tests can share the exact same insert shape. Intentionally minimal:
 * caller decides whether to swallow or propagate errors.
 *
 * Throws if payload.resource_url is missing or non-string (belt + braces —
 * the route handler already 400s before here, but a defense-in-depth guard
 * stops a malformed payload from landing in the DLQ in the first place).
 */
export async function enqueueShipStationRetry(
  dbArg: any,
  payload: { resource_url: string }
): Promise<void> {
  if (!payload || typeof payload.resource_url !== "string" || payload.resource_url.length === 0) {
    throw new Error("enqueueShipStationRetry: payload.resource_url required");
  }

  await dbArg.insert(webhookRetryQueue).values({
    provider: "shipstation",
    topic: "SHIP_NOTIFY",
    payload: { resource_url: payload.resource_url },
    // attempts defaults to 0, status defaults to 'pending' via schema defaults,
    // but set them explicitly so tests don't depend on DB defaults.
    attempts: 0,
    status: "pending",
    // First retry ~5 minutes out. Worker's exponential backoff takes over
    // on subsequent failures (2^attempts minutes).
    nextRetryAt: new Date(Date.now() + 5 * 60_000),
  });
}

/**
 * Shape of the small subset of ShipStationService we need for retry dispatch.
 * Keeps the worker decoupled from the full service type.
 */
export interface RetryShipStationService {
  processShipNotify(resourceUrl: string): Promise<number>;
}

/**
 * Resolve the ShipStation service the worker should invoke.
 *
 * Follows the same db-stash pattern already used by `__fulfillmentPush`
 * in shipstation.service.ts: the boot site in server/index.ts pokes the
 * instance onto db, and the worker reads it back here. Keeps us from
 * threading services through the scheduler start surface.
 */
function resolveShipStationService(dbArg: any): RetryShipStationService | null {
  const svc = dbArg?.__shipStationService;
  if (svc && typeof svc.processShipNotify === "function") {
    return svc as RetryShipStationService;
  }
  return null;
}

/**
 * One step of retry-failure bookkeeping. Exported for tests.
 *
 * Matches the exact pattern used by the legacy shopify branch in this file:
 * - increment attempts
 * - if attempts >= MAX_ATTEMPTS → status='dead'
 * - otherwise → status='pending' with 2^attempts minute backoff
 * - always record last_error
 */
export async function recordRetryFailure(
  dbArg: any,
  item: { id: number; attempts: number },
  errMessage: string
): Promise<{ attempts: number; status: "dead" | "pending"; nextRetryAt: Date }> {
  const attempts = item.attempts + 1;
  const status: "dead" | "pending" = attempts >= MAX_ATTEMPTS ? "dead" : "pending";

  // Exponential backoff: 2^attempts minutes. (1: 2m, 2: 4m, 3: 8m...)
  const delayMinutes = Math.pow(2, attempts);
  const nextRetryAt = new Date(Date.now() + delayMinutes * 60000);

  await dbArg
    .update(webhookRetryQueue)
    .set({
      attempts,
      status,
      nextRetryAt,
      lastError: errMessage,
      updatedAt: new Date(),
    })
    .where(eq(webhookRetryQueue.id, item.id));

  return { attempts, status, nextRetryAt };
}

/**
 * Dispatch a single pending row for the shipstation provider.
 * Exported for unit testing.
 */
export async function dispatchShipStationRetry(
  dbArg: any,
  item: { id: number; provider: string; topic: string; payload: any; attempts: number }
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { resource_url?: string } | null;
  const resourceUrl = payload?.resource_url;

  if (!resourceUrl || typeof resourceUrl !== "string") {
    // Malformed row — dead-letter immediately. Retrying a missing
    // resource_url will never succeed, so burning attempts is wasteful.
    await dbArg
      .update(webhookRetryQueue)
      .set({
        status: "dead",
        lastError: "malformed payload: missing resource_url",
        updatedAt: new Date(),
      })
      .where(eq(webhookRetryQueue.id, item.id));
    console.error(`${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shipstation payload)`);
    return "malformed";
  }

  const shipStationService = resolveShipStationService(dbArg);
  if (!shipStationService) {
    // Service not wired — treat as transient failure so the next tick retries.
    const { status } = await recordRetryFailure(
      dbArg,
      item,
      "shipStation service not available on db.__shipStationService"
    );
    console.warn(`${LOG_PREFIX} Item ${item.id} deferred — SS service unavailable (status=${status})`);
    return status;
  }

  try {
    await shipStationService.processShipNotify(resourceUrl);
    await dbArg
      .update(webhookRetryQueue)
      .set({ status: "success", updatedAt: new Date() })
      .where(eq(webhookRetryQueue.id, item.id));
    console.log(`${LOG_PREFIX} Item ${item.id} (shipstation SHIP_NOTIFY) succeeded`);
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err)
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shipstation SHIP_NOTIFY) moved to DLQ after ${attempts} attempts`
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation SHIP_NOTIFY) failed again. Next retry at ${nextRetryAt.toISOString()}`
      );
    }
    return status;
  }
}

async function processPendingWebhooks() {
  const pending = await defaultDb
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

  for (const item of pending) {
    // ShipStation SHIP_NOTIFY branch — call SS service directly, no loopback.
    if (item.provider === "shipstation" && item.topic === "SHIP_NOTIFY") {
      try {
        await dispatchShipStationRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        // Defensive: the helper already records failures; this catch only
        // fires if the bookkeeping itself throws. Log + move on.
        console.error(
          `${LOG_PREFIX} Item ${item.id} shipstation dispatch threw: ${branchErr?.message || branchErr}`
        );
      }
      continue;
    }

    // Legacy shopify / other providers — HTTP loopback path.
    if (!secret) {
      console.error(`${LOG_PREFIX} Missing SESSION_SECRET, cannot run loopbacks`);
      return;
    }

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
        await defaultDb
          .update(webhookRetryQueue)
          .set({ status: "success", updatedAt: new Date() })
          .where(eq(webhookRetryQueue.id, item.id));
        console.log(`${LOG_PREFIX} Item ${item.id} succeeded`);
      } else {
        // Still failed
        throw new Error(`Local API returned ${res.status}`);
      }
    } catch (itemErr: any) {
      const { status, attempts, nextRetryAt } = await recordRetryFailure(
        defaultDb,
        item as any,
        itemErr?.message || String(itemErr)
      );

      if (status === "dead") {
        console.error(`${LOG_PREFIX} Item ${item.id} moved to DLQ (dead letter) after ${attempts} attempts`);
        // TODO: Fire an alert or slack notification here in the future
      } else {
        console.warn(`${LOG_PREFIX} Item ${item.id} failed again. Next retry at ${nextRetryAt.toISOString()}`);
      }
    }
  }
}

// Keep `sql` imported above usable; re-export for other modules that want
// to look at the queue directly (mirrors original file semantics).
export { sql };
