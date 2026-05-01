import { webhookRetryQueue } from "@shared/schema";
import { eq, lte, and, sql } from "drizzle-orm";
import { incr } from "../../instrumentation/metrics";

const MAX_ATTEMPTS = 5;

/**
 * Lazy default-db accessor. The worker is the only entry point that
 * actually needs a real Postgres handle, and we only need it inside
 * `processPendingWebhooks` (the polling loop). Importing `db` at the
 * top of this file would force every consumer that calls
 * `enqueueShipStationRetry` / `enqueueShopifyFulfillmentRetry` to
 * also satisfy DATABASE_URL at module-load time — painful for unit
 * tests that inject their own db mock and never start the worker.
 */
function getDefaultDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../db").db;
}
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
 * Shape of the small subset of FulfillmentPushService the retry worker
 * needs to re-dispatch a `shopify_fulfillment_push` row. C22d wires this
 * via the same `db.__fulfillmentPush` stash already used by the V2
 * SHIP_NOTIFY hot path.
 *
 * The retry worker only cares about the boolean success of the push;
 * the full `{shopifyFulfillmentId, alreadyPushed}` shape is consumed
 * but not asserted on so callers can keep the contract minimal.
 */
export interface RetryFulfillmentPushService {
  pushShopifyFulfillment(
    shipmentId: number,
  ): Promise<{ shopifyFulfillmentId: string | null; alreadyPushed: boolean }>;
}

/**
 * Enqueue a failed Shopify fulfillment push for retry.
 *
 * provider='internal' because the retry worker re-dispatches by calling
 * the in-process service rather than re-issuing an HTTP webhook.
 * topic='shopify_fulfillment_push'
 * payload={ shipmentId }
 *
 * Per Overlord D6/D7. Mirrors `enqueueShipStationRetry` shape so the
 * existing worker poll loop just needs a new dispatch branch.
 */
export async function enqueueShopifyFulfillmentRetry(
  dbArg: any,
  shipmentId: number,
  cause: unknown,
): Promise<void> {
  if (
    typeof shipmentId !== "number" ||
    !Number.isInteger(shipmentId) ||
    shipmentId <= 0
  ) {
    throw new Error(
      `enqueueShopifyFulfillmentRetry: shipmentId must be a positive integer (got ${shipmentId})`,
    );
  }
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : cause == null
          ? ""
          : String(cause);

  await dbArg.insert(webhookRetryQueue).values({
    provider: "internal",
    topic: "shopify_fulfillment_push",
    payload: { shipmentId },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    // First retry ~5 minutes out (matches enqueueShipStationRetry).
    // Worker's exponential backoff (2^attempts minutes) takes over
    // on subsequent failures via recordRetryFailure.
    nextRetryAt: new Date(Date.now() + 5 * 60_000),
  });
}

/**
 * Enqueue a delayed tracking push for non-Shopify channels (like eBay).
 * Intentionally delayed by 5 minutes to allow carriers (e.g. USPS) to fully
 * index the tracking number before eBay's asynchronous REST validation hits it.
 */
export async function enqueueDelayedTrackingPush(
  dbArg: any,
  orderId: number,
): Promise<void> {
  if (
    typeof orderId !== "number" ||
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {
    throw new Error(
      `enqueueDelayedTrackingPush: orderId must be a positive integer (got ${orderId})`,
    );
  }

  await dbArg.insert(webhookRetryQueue).values({
    provider: "internal",
    topic: "delayed_tracking_push",
    payload: { orderId },
    attempts: 0,
    status: "pending",
    // 5-minute initial delay
    nextRetryAt: new Date(Date.now() + 5 * 60_000),
  });
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
 * Resolve the in-process Shopify fulfillment push service. Same pattern
 * as `resolveShipStationService` but reads the `__fulfillmentPush`
 * stash. See C22d for the wiring rationale.
 */
function resolveFulfillmentPushService(
  dbArg: any,
): any | null {
  const svc = dbArg?.__fulfillmentPush;
  if (svc) {
    return svc;
  }
  return null;
}

/**
 * Dispatch a single pending row for the Shopify-fulfillment-push retry
 * branch (`provider='internal' + topic='shopify_fulfillment_push'`).
 * Exported for unit testing.
 *
 * Behavior matrix:
 *   - malformed payload (missing/invalid shipmentId)  → dead immediately
 *   - service handle not wired                       → keep pending
 *   - push succeeds                                  → mark row success
 *   - push throws → recordRetryFailure (transient or dead at MAX_ATTEMPTS)
 */
export async function dispatchShopifyFulfillmentRetry(
  dbArg: any,
  item: { id: number; provider: string; topic: string; payload: any; attempts: number },
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { shipmentId?: number } | null;
  const shipmentId = payload?.shipmentId;

  if (
    typeof shipmentId !== "number" ||
    !Number.isInteger(shipmentId) ||
    shipmentId <= 0
  ) {
    await markRowDead(
      dbArg,
      item.id,
      "malformed payload: shipmentId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shopify_fulfillment_push payload)`,
    );
    return "malformed";
  }

  const fulfillmentPush = resolveFulfillmentPushService(dbArg);
  if (!fulfillmentPush) {
    // Service not wired — graceful degrade. Don't burn an attempt on a
    // boot-order issue; the next worker tick will likely succeed once
    // server/index.ts has stashed the service.
    await keepPending(
      dbArg,
      item.id,
      "fulfillment push service not available on db.__fulfillmentPush",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push) deferred — fulfillment push service unavailable`,
    );
    return "pending";
  }

  try {
    await fulfillmentPush.pushShopifyFulfillment(shipmentId);
    await markRowSuccess(dbArg, item.id);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "shopify_fulfillment_push", shipmentId },
    );
    if (status === "dead") {
      // recordRetryFailure already emitted the CRITICAL: line; add a
      // worker-level summary at the same severity for log drains that
      // grep on the `[Webhook DLQ Worker]` prefix.
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) failed again. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

/**
 * Dispatch a single pending row for the delayed tracking push branch.
 */
export async function dispatchDelayedTrackingPush(
  dbArg: any,
  item: { id: number; provider: string; topic: string; payload: any; attempts: number },
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { orderId?: number } | null;
  const orderId = payload?.orderId;

  if (
    typeof orderId !== "number" ||
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item.id,
      "malformed payload: orderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed delayed_tracking_push payload)`,
    );
    return "malformed";
  }

  const fulfillmentPush = resolveFulfillmentPushService(dbArg);
  if (!fulfillmentPush || typeof fulfillmentPush.pushTracking !== "function") {
    await keepPending(
      dbArg,
      item.id,
      "fulfillment push service not available",
    );
    return "pending";
  }

  try {
    const pushed = await fulfillmentPush.pushTracking(orderId);
    await markRowSuccess(dbArg, item.id);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}) succeeded (pushed=${pushed})`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "delayed_tracking_push" },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

/**
 * One step of retry-failure bookkeeping. Exported for tests.
 *
 * Matches the exact pattern used by the legacy shopify branch in this file:
 * - increment attempts
 * - if attempts >= MAX_ATTEMPTS → status='dead'
 * - otherwise → status='pending' with 2^attempts minute backoff
 * - always record last_error
 *
 * On dead-letter (attempts == MAX_ATTEMPTS) emit a `CRITICAL:`-prefixed
 * console.error in the format the log drain → Discord alerter expects.
 * Optional `meta` lets callers shape the headline (e.g. include the
 * shipment id / topic). Per Overlord D6.
 */
export async function recordRetryFailure(
  dbArg: any,
  item: { id: number; attempts: number; topic?: string; payload?: any },
  errMessage: string,
  meta: { topic?: string; shipmentId?: number } = {},
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

  if (status === "dead") {
    const topic = meta.topic ?? item.topic;
    const headline =
      topic === "shopify_fulfillment_push"
        ? "CRITICAL: Shopify Fulfillment Push Dead-Lettered"
        : `CRITICAL: ${topic ?? item.topic ?? "Unknown"} Dead-Lettered`;
    const idLine =
      typeof meta.shipmentId === "number"
        ? `Shipment ID: ${meta.shipmentId}`
        : `Queue Row ID: ${item.id}`;
    // Format chosen to be greppable by the existing log drain →
    // Discord alerter. Keep newlines literal so multi-line context
    // arrives intact (do not JSON.stringify).
    console.error(
      `${headline}\n${idLine}\nQueue Row ID: ${item.id}\nAttempts: ${attempts}\nLast Error: ${errMessage}`,
    );
  }

  return { attempts, status, nextRetryAt };
}

/**
 * Mark a queue row dead immediately (used for non-retryable malformed
 * payloads). No CRITICAL log here: a malformed row is an ingest bug,
 * not a downstream outage worth paging on.
 */
async function markRowDead(
  dbArg: any,
  rowId: number,
  reason: string,
): Promise<void> {
  await dbArg
    .update(webhookRetryQueue)
    .set({
      status: "dead",
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(webhookRetryQueue.id, rowId));
}

/**
 * Keep a row pending without incrementing attempts. Used when a
 * required service handle is missing (graceful degrade — the row will
 * be retried on the next worker tick once boot wires the stash).
 */
async function keepPending(
  dbArg: any,
  rowId: number,
  reason: string,
): Promise<void> {
  await dbArg
    .update(webhookRetryQueue)
    .set({
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(webhookRetryQueue.id, rowId));
}

/**
 * Mark a row succeeded.
 */
async function markRowSuccess(dbArg: any, rowId: number): Promise<void> {
  await dbArg
    .update(webhookRetryQueue)
    .set({ status: "success", updatedAt: new Date() })
    .where(eq(webhookRetryQueue.id, rowId));
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
  const defaultDb = getDefaultDb();
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

    // C22d Shopify fulfillment push retry branch — re-call the in-process
    // service rather than issue an HTTP loopback (provider='internal').
    if (
      item.provider === "internal" &&
      item.topic === "shopify_fulfillment_push"
    ) {
      try {
        await dispatchShopifyFulfillmentRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} shopify_fulfillment_push dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "delayed_tracking_push"
    ) {
      try {
        await dispatchDelayedTrackingPush(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} delayed_tracking_push dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    // Shopify inbound webhook retry branch (C30) — HTTP loopback with
    // correct URL mapping per topic. Fulfillments/* live on
    // /api/shopify/webhooks/*, everything else on /api/oms/webhooks/*.
    if (item.provider === "shopify") {
      if (!secret) {
        console.error(`${LOG_PREFIX} Missing SESSION_SECRET, cannot run shopify loopbacks`);
        continue;
      }

      const FULFILLMENT_TOPICS = new Set(["fulfillments/create", "fulfillments/update"]);
      const KNOWN_TOPICS = new Set([
        "orders/paid", "orders/updated", "orders/cancelled", "orders/fulfilled",
        "refunds/create", "fulfillments/create", "fulfillments/update",
      ]);

      // Unknown topic → dead immediately (non-retryable bad data)
      if (!KNOWN_TOPICS.has(item.topic)) {
        console.error(`${LOG_PREFIX} Item ${item.id} unknown shopify topic '${item.topic}' — marking dead`);
        await defaultDb
          .update(webhookRetryQueue)
          .set({ status: "dead", lastError: `Unknown topic: ${item.topic}`, updatedAt: new Date() })
          .where(eq(webhookRetryQueue.id, item.id));
        continue;
      }

      try {
        console.log(`${LOG_PREFIX} Retrying shopify item ${item.id} (${item.topic}), attempt ${item.attempts + 1}`);

        const basePath = FULFILLMENT_TOPICS.has(item.topic)
          ? "/api/shopify/webhooks"
          : "/api/oms/webhooks";
        const url = `http://127.0.0.1:${process.env.PORT || 5000}${basePath}/${item.topic}`;
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
          await defaultDb
            .update(webhookRetryQueue)
            .set({ status: "success", updatedAt: new Date() })
            .where(eq(webhookRetryQueue.id, item.id));
          console.log(`${LOG_PREFIX} Item ${item.id} (${item.topic}) succeeded`);
        } else {
          throw new Error(`Local API returned ${res.status}`);
        }
      } catch (itemErr: any) {
        const { status, attempts, nextRetryAt } = await recordRetryFailure(
          defaultDb,
          item as any,
          itemErr?.message || String(itemErr),
        );

        if (status === "dead") {
          // Shopify-specific dead-letter format for Discord alerter
          const orderId = (item.payload as any)?.order_id
            ?? (item.payload as any)?.id
            ?? "unknown";
          console.error(
            `CRITICAL: Shopify Webhook Dead-Lettered\nTopic: ${item.topic}\nOrder: ${orderId}\nLast Error: ${itemErr?.message || String(itemErr)}\nAttempts: ${attempts}\nQueue Row ID: ${item.id}`,
          );
        } else {
          console.warn(`${LOG_PREFIX} Item ${item.id} (${item.topic}) failed again. Next retry at ${nextRetryAt.toISOString()}`);
        }
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
        incr("shopify_webhook_dlq_dead_letter", 1, {
          provider: item.provider,
          topic: item.topic,
          attempts,
          rowId: item.id,
        });
        // TODO: Fire an alert or slack notification here in the future
      } else {
        console.warn(`${LOG_PREFIX} Item ${item.id} failed again. Next retry at ${nextRetryAt.toISOString()}`);
        incr("shopify_webhook_retry_processed", 1, {
          provider: item.provider,
          topic: item.topic,
          attempts,
          outcome: "transient_failure",
        });
      }
    }
  }
}

// Keep `sql` imported above usable; re-export for other modules that want
// to look at the queue directly (mirrors original file semantics).
export { sql };
