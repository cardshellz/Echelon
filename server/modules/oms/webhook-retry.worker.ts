import { webhookRetryQueue } from "@shared/schema";
import { eq, lte, and, sql } from "drizzle-orm";
import { incr } from "../../instrumentation/metrics";
import { createShipmentForOrder } from "../wms/create-shipment";
// Stable error code for a deterministic, non-retryable ShipStation push
// rejection (bad address/total/country, not-pushable status, finalized order).
// Imported (not string-literal'd) so a rename stays in sync. shipstation.service
// only imports this worker via dynamic import(), so this static import is cycle-safe.
import { SS_PUSH_INVALID_SHIPMENT } from "./shipstation.service";
import { isEbayTrackingConflictError } from "./channel-fulfillment-conflict";

const MAX_ATTEMPTS = 5;
const SHOPIFY_PUSH_CLIENT_NOT_SET = "shopify_push_client_not_set";
// Deterministic, non-retryable Shopify push rejection (zero-qty items, missing
// shipment/order linkage — bad input that identical retries can never fix).
// Local literal like SHOPIFY_PUSH_CLIENT_NOT_SET above: fulfillment-push.service
// is resolved via the db stash, not imported, so we keep zero static coupling.
// Must match SHOPIFY_PUSH_INVALID_INPUT in fulfillment-push.service.ts (guarded
// by a unit test).
const SHOPIFY_PUSH_INVALID_INPUT = "shopify_push_invalid_input";
const RETRY_SCOPE_UNIQUE_INDEX_PREFIX = "uq_webhook_retry_pending_";
type RetryDispatchItem = {
  id: number;
  provider: string;
  topic: string;
  payload: any;
  attempts: number;
  sourceInboxId?: number | null;
};

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
let retryWorkerStartedAt: Date | null = null;
let retryWorkerLastRunAt: Date | null = null;
let retryWorkerLastSuccessAt: Date | null = null;
let retryWorkerLastError: string | null = null;

async function getSourceInboxReplayHeaders(
  dbArg: any,
  sourceInboxId: number | null | undefined,
): Promise<Record<string, string>> {
  const inboxId = Number(sourceInboxId);
  if (!Number.isInteger(inboxId) || inboxId <= 0) return {};

  const result = await dbArg.execute(sql`
    SELECT headers, source_domain
    FROM oms.webhook_inbox
    WHERE id = ${inboxId}
    LIMIT 1
  `);
  const row = result?.rows?.[0];
  const headers = (row?.headers ?? {}) as Record<string, unknown>;
  const replayHeaders: Record<string, string> = {};

  for (const key of [
    "x-shopify-shop-domain",
    "x-shopify-topic",
    "x-shopify-webhook-id",
    "x-shopify-triggered-at",
  ]) {
    const value = headers[key];
    if (typeof value === "string" && value.length > 0) {
      replayHeaders[key] = value;
    }
  }

  if (!replayHeaders["x-shopify-shop-domain"] && row?.source_domain) {
    replayHeaders["x-shopify-shop-domain"] = String(row.source_domain);
  }

  return replayHeaders;
}
let retryWorkerLastSkippedAt: Date | null = null;
let retryWorkerRunInFlight = false;
let retryWorkerTimer: ReturnType<typeof setInterval> | null = null;

export interface WebhookRetryWorkerHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastSkippedAt: string | null;
  inFlight: boolean;
}

export function getWebhookRetryWorkerHeartbeat(): WebhookRetryWorkerHeartbeat {
  return {
    startedAt: retryWorkerStartedAt?.toISOString() ?? null,
    lastRunAt: retryWorkerLastRunAt?.toISOString() ?? null,
    lastSuccessAt: retryWorkerLastSuccessAt?.toISOString() ?? null,
    lastError: retryWorkerLastError,
    lastSkippedAt: retryWorkerLastSkippedAt?.toISOString() ?? null,
    inFlight: retryWorkerRunInFlight,
  };
}

export function resetWebhookRetryWorkerHeartbeatForTest(): void {
  retryWorkerStartedAt = null;
  retryWorkerLastRunAt = null;
  retryWorkerLastSuccessAt = null;
  retryWorkerLastError = null;
  retryWorkerLastSkippedAt = null;
  retryWorkerRunInFlight = false;
  if (retryWorkerTimer) {
    clearInterval(retryWorkerTimer);
    retryWorkerTimer = null;
  }
}

export async function runWebhookRetryWorkerTick(
  processor: () => Promise<void> = processPendingWebhooks,
): Promise<"success" | "error" | "skipped"> {
  if (retryWorkerRunInFlight) {
    retryWorkerLastSkippedAt = new Date();
    console.warn(`${LOG_PREFIX} Skipping retry tick because previous run is still in flight`);
    return "skipped";
  }

  retryWorkerRunInFlight = true;
  retryWorkerLastRunAt = new Date();

  try {
    await processor();
    retryWorkerLastSuccessAt = new Date();
    retryWorkerLastError = null;
    return "success";
  } catch (err) {
    retryWorkerLastError = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Error in worker loop:`, err);
    return "error";
  } finally {
    retryWorkerRunInFlight = false;
  }
}

/**
 * Polls the webhook_retry_queue for pending items that are due for a retry.
 */
export async function startWebhookRetryWorker() {
  if (retryWorkerTimer) {
    console.warn(`${LOG_PREFIX} Worker already started; ignoring duplicate start`);
    return;
  }

  retryWorkerStartedAt = new Date();
  console.log(`${LOG_PREFIX} Started background webhook retry worker`);

  void runWebhookRetryWorkerTick();
  retryWorkerTimer = setInterval(() => {
    void runWebhookRetryWorkerTick();
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "shipstation",
    topic: "SHIP_NOTIFY",
    scope: sql`payload->>'resource_url' = ${payload.resource_url}`,
  })) {
    return;
  }

  await insertWebhookRetryQueueRow(dbArg, {
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
  pushShipment?(shipmentId: number): Promise<unknown>;
  syncWmsOrderShipStationHoldState?(
    wmsOrderId: number,
    mode: "hold" | "release",
  ): Promise<{ touched: number }>;
  updateSortRank?(wmsOrderId: number): Promise<{ touched: number }>;
}

/**
 * Shape of the small subset of FulfillmentPushService the retry worker
 * needs to re-dispatch a `shopify_fulfillment_push` row. C22d wires this
 * via the same `db.__fulfillmentPush` stash already used by the V2
 * SHIP_NOTIFY hot path.
 *
 * The retry worker only marks the row successful when `writebackComplete`
 * proves every Shopify-owned quantity in the current package is covered.
 * A fulfillment id alone is historical identity, not completion evidence.
 */
export interface RetryFulfillmentPushService {
  pushShopifyFulfillment(
    shipmentId: number,
  ): Promise<{
    shopifyFulfillmentId: string | null;
    alreadyPushed: boolean;
    writebackComplete: boolean;
  }>;
  pushTracking?(orderId: number): Promise<boolean>;
  pushTrackingForShipment?(shipmentId: number): Promise<boolean>;
}

export interface RetryEbayWebhookReplayService {
  omsService: unknown;
  ebayApiClient: unknown;
  reingestEbayOrder(
    orderId: string,
    omsService: unknown,
    ebayApiClient: unknown,
  ): Promise<{ status: string; omsOrderId: number }>;
}

export interface RetryWmsSyncService {
  syncOmsOrderToWms(omsOrderId: number): Promise<number | null>;
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "shopify_fulfillment_push",
    scope: sql`payload->>'shipmentId' = ${String(shipmentId)}`,
  })) {
    return;
  }

  // Single chokepoint (mirrors enqueueShipStationShipmentPushRetry): never
  // re-enqueue a shipment already flagged for operator review. A PERMANENT
  // Shopify push failure (SHOPIFY_PUSH_INVALID_INPUT — e.g. zero-qty items from
  // the split sync bug) dead-letters and stamps requires_review; without this
  // guard the hourly fulfillment sweeper and the 15-min reconciler re-inserted a
  // fresh pending row for the same shipment forever (one shipment accumulated
  // 168 dead rows). pending-only dedupe above cannot stop that — dead rows
  // don't dedupe. The operator fixes the data + clears requires_review to
  // re-enter the pipeline.
  if (typeof dbArg?.execute === "function") {
    const flagged = await dbArg.execute(sql`
      SELECT 1 FROM wms.outbound_shipments
      WHERE id = ${shipmentId} AND requires_review = true
      LIMIT 1
    `);
    if ((flagged?.rows?.length ?? 0) > 0) {
      return;
    }
  }

  try {
    await insertWebhookRetryQueueRow(dbArg, {
      provider: "internal",
      topic: "shopify_fulfillment_push",
      payload: { shipmentId },
      attempts: 0,
      status: "pending",
      lastError: message || null,
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
    });
  } catch (err: any) {
    // D-RETRYDEDUP: Unique index catches race between concurrent enqueues
    if (err?.code === "23505" && String(err?.constraint ?? "").includes("pending_dedup")) {
      return;
    }
    throw err;
  }
}

/**
 * Enqueue a delayed tracking push for non-Shopify channels (like eBay).
 * Intentionally delayed by 5 minutes to allow carriers (e.g. USPS) to fully
 * index the tracking number before eBay's asynchronous REST validation hits it.
 */
export async function enqueueDelayedTrackingPush(
  dbArg: any,
  orderId: number,
  shipmentId?: number,
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
  if (
    shipmentId !== undefined &&
    (typeof shipmentId !== "number" ||
      !Number.isInteger(shipmentId) ||
      shipmentId <= 0)
  ) {
    throw new Error(
      `enqueueDelayedTrackingPush: shipmentId must be a positive integer when provided (got ${shipmentId})`,
    );
  }

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "delayed_tracking_push",
    scope: shipmentId !== undefined
      ? sql`payload->>'shipmentId' = ${String(shipmentId)}`
      : sql`payload->>'orderId' = ${String(orderId)} AND payload->>'shipmentId' IS NULL`,
  })) {
    return;
  }

  try {
    await insertWebhookRetryQueueRow(dbArg, {
      provider: "internal",
      topic: "delayed_tracking_push",
      payload: shipmentId ? { orderId, shipmentId } : { orderId },
      attempts: 0,
      status: "pending",
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
    });
  } catch (err: any) {
    // D-RETRYDEDUP: Unique index catches race between concurrent enqueues
    if (err?.code === "23505" && String(err?.constraint ?? "").includes("pending_dedup")) {
      return;
    }
    throw err;
  }
}

export async function enqueueOmsWmsSyncRetry(
  dbArg: any,
  omsOrderId: number,
  cause?: unknown,
): Promise<void> {
  if (
    typeof omsOrderId !== "number" ||
    !Number.isInteger(omsOrderId) ||
    omsOrderId <= 0
  ) {
    throw new Error(
      `enqueueOmsWmsSyncRetry: omsOrderId must be a positive integer (got ${omsOrderId})`,
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "oms_wms_sync",
    scope: sql`payload->>'omsOrderId' = ${String(omsOrderId)}`,
  })) {
    return;
  }

  await insertWebhookRetryQueueRow(dbArg, {
    provider: "internal",
    topic: "oms_wms_sync",
    payload: { omsOrderId },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    nextRetryAt: new Date(),
  });
}

export async function enqueueWmsShipmentCreateRetry(
  dbArg: any,
  wmsOrderId: number,
  cause?: unknown,
): Promise<void> {
  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    throw new Error(
      `enqueueWmsShipmentCreateRetry: wmsOrderId must be a positive integer (got ${wmsOrderId})`,
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "wms_shipment_create",
    scope: sql`payload->>'wmsOrderId' = ${String(wmsOrderId)}`,
  })) {
    return;
  }

  await insertWebhookRetryQueueRow(dbArg, {
    provider: "internal",
    topic: "wms_shipment_create",
    payload: { wmsOrderId },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    nextRetryAt: new Date(),
  });
}

export async function enqueueShipStationShipmentPushRetry(
  dbArg: any,
  shipmentId: number,
  cause?: unknown,
): Promise<void> {
  if (
    typeof shipmentId !== "number" ||
    !Number.isInteger(shipmentId) ||
    shipmentId <= 0
  ) {
    throw new Error(
      `enqueueShipStationShipmentPushRetry: shipmentId must be a positive integer (got ${shipmentId})`,
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "shipstation_shipment_push",
    scope: sql`payload->>'shipmentId' = ${String(shipmentId)}`,
  })) {
    return;
  }

  // Single chokepoint: never re-enqueue a shipment already flagged for operator
  // review. A permanent push failure (bad address/total/country) sets
  // requires_review and dead-letters the row; every caller of this function —
  // the stale-push reconciler AND the event-driven paths in wms-sync.service.ts
  // (sync/reconcile/edit) and oms-webhooks.ts (address change) — funnels through
  // here, so guarding once closes all of them. Without this, those callers would
  // re-insert a fresh pending row on every sync tick / webhook (hasPendingRetry-
  // ForScope only dedupes 'pending', not the 'dead' row), reopening the loop.
  // The operator must fix the data + clear requires_review to re-enter the pipeline.
  if (typeof dbArg?.execute === "function") {
    const flagged = await dbArg.execute(sql`
      SELECT 1 FROM wms.outbound_shipments
      WHERE id = ${shipmentId} AND requires_review = true
      LIMIT 1
    `);
    if ((flagged?.rows?.length ?? 0) > 0) {
      return;
    }
  }

  await insertWebhookRetryQueueRow(dbArg, {
    provider: "internal",
    topic: "shipstation_shipment_push",
    payload: { shipmentId },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    nextRetryAt: new Date(),
  });
}

export async function enqueueShipStationHoldSyncRetry(
  dbArg: any,
  wmsOrderId: number,
  requestedMode: "hold" | "release",
  cause?: unknown,
): Promise<void> {
  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    throw new Error(
      `enqueueShipStationHoldSyncRetry: wmsOrderId must be a positive integer (got ${wmsOrderId})`,
    );
  }
  if (requestedMode !== "hold" && requestedMode !== "release") {
    throw new Error(
      `enqueueShipStationHoldSyncRetry: requestedMode must be hold or release (got ${requestedMode})`,
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "shipstation_hold_sync",
    scope: sql`payload->>'wmsOrderId' = ${String(wmsOrderId)}`,
  })) {
    return;
  }

  await insertWebhookRetryQueueRow(dbArg, {
    provider: "internal",
    topic: "shipstation_hold_sync",
    payload: { wmsOrderId, requestedMode },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    nextRetryAt: new Date(),
  });
}

export async function enqueueShipStationSortRankSyncRetry(
  dbArg: any,
  wmsOrderId: number,
  cause?: unknown,
): Promise<void> {
  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    throw new Error(
      `enqueueShipStationSortRankSyncRetry: wmsOrderId must be a positive integer (got ${wmsOrderId})`,
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

  if (await hasPendingRetryForScope(dbArg, {
    provider: "internal",
    topic: "shipstation_sort_rank_sync",
    scope: sql`payload->>'wmsOrderId' = ${String(wmsOrderId)}`,
  })) {
    return;
  }

  await insertWebhookRetryQueueRow(dbArg, {
    provider: "internal",
    topic: "shipstation_sort_rank_sync",
    payload: { wmsOrderId },
    attempts: 0,
    status: "pending",
    lastError: message || null,
    nextRetryAt: new Date(),
  });
}

async function hasPendingRetryForScope(
  dbArg: any,
  input: {
    provider: string;
    topic: string;
    scope: any;
  },
): Promise<boolean> {
  if (typeof dbArg?.execute !== "function") {
    return false;
  }

  const existing: any = await dbArg.execute(sql`
    SELECT id
    FROM oms.webhook_retry_queue
    WHERE provider = ${input.provider}
      AND topic = ${input.topic}
      AND status = 'pending'
      AND ${input.scope}
    LIMIT 1
  `);
  return Boolean(existing?.rows?.[0]);
}

async function insertWebhookRetryQueueRow(
  dbArg: any,
  values: Record<string, unknown>,
): Promise<void> {
  try {
    await dbArg.insert(webhookRetryQueue).values(values);
  } catch (error) {
    if (isRetryScopeUniqueViolation(error)) {
      return;
    }
    throw error;
  }
}

function isRetryScopeUniqueViolation(error: unknown): boolean {
  const pgError = findPgErrorLike(error);
  if (!pgError || pgError.code !== "23505") {
    return false;
  }

  const constraint =
    typeof pgError.constraint === "string"
      ? pgError.constraint
      : typeof pgError.constraint_name === "string"
        ? pgError.constraint_name
        : null;

  return Boolean(
    constraint && constraint.startsWith(RETRY_SCOPE_UNIQUE_INDEX_PREFIX),
  );
}

function findPgErrorLike(error: unknown): {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
} | null {
  let current = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") {
      return null;
    }

    const record = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      typeof record.code === "string" ||
      typeof record.constraint === "string" ||
      typeof record.constraint_name === "string"
    ) {
      return record;
    }

    current = record.cause;
  }

  return null;
}

export interface WebhookRetryRequeueResult {
  retryQueueId: number;
  provider: string;
  topic: string;
  previousStatus: string;
}

export async function requeueDeadWebhookRetry(
  dbArg: any,
  retryQueueId: number,
  operator: string,
): Promise<WebhookRetryRequeueResult> {
  if (!Number.isInteger(retryQueueId) || retryQueueId <= 0) {
    throw new Error(`webhook retry id must be a positive integer (got ${retryQueueId})`);
  }

  const result = await dbArg.execute(sql`
    UPDATE oms.webhook_retry_queue
    SET status = 'pending',
        attempts = 0,
        next_retry_at = NOW(),
        last_error = ${`manual requeue by ${operator || "unknown"}`},
        updated_at = NOW()
    WHERE id = ${retryQueueId}
      AND status = 'dead'
    RETURNING id, provider, topic, 'dead'::text AS previous_status
  `);

  const row = Array.isArray(result?.rows) ? result.rows[0] : null;
  if (!row) {
    const existing = await dbArg.execute(sql`
      SELECT id, provider, topic, status
      FROM oms.webhook_retry_queue
      WHERE id = ${retryQueueId}
      LIMIT 1
    `);
    const existingRow = Array.isArray(existing?.rows) ? existing.rows[0] : null;
    if (!existingRow) {
      throw new Error(`webhook retry row ${retryQueueId} not found`);
    }
    throw new Error(`webhook retry row ${retryQueueId} is not dead-lettered (status=${existingRow.status})`);
  }

  return {
    retryQueueId: Number(row.id),
    provider: String(row.provider),
    topic: String(row.topic),
    previousStatus: String(row.previous_status),
  };
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

function resolveShippingEngine(dbArg: any): any | null {
  return dbArg?.__shippingEngine ?? null;
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

function resolveEbayWebhookReplayService(
  dbArg: any,
): RetryEbayWebhookReplayService | null {
  const svc = dbArg?.__ebayWebhookReplay;
  if (
    svc &&
    svc.omsService &&
    svc.ebayApiClient &&
    typeof svc.reingestEbayOrder === "function"
  ) {
    return svc as RetryEbayWebhookReplayService;
  }
  return null;
}

function resolveWmsSyncService(dbArg: any): RetryWmsSyncService | null {
  const svc = dbArg?.__wmsSyncService;
  if (svc && typeof svc.syncOmsOrderToWms === "function") {
    return svc as RetryWmsSyncService;
  }
  return null;
}

function isShopifyClientNotReadyError(err: any): boolean {
  const code =
    err?.context?.code ??
    err?.code ??
    err?.cause?.code ??
    null;
  if (code === SHOPIFY_PUSH_CLIENT_NOT_SET) {
    return true;
  }

  const message = String(err?.message ?? err ?? "").toLowerCase();
  return message.includes("shopify client not initialized");
}

export async function dispatchOmsWmsSyncRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { omsOrderId?: number } | null;
  const omsOrderId = payload?.omsOrderId;

  if (
    typeof omsOrderId !== "number" ||
    !Number.isInteger(omsOrderId) ||
    omsOrderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: omsOrderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed oms_wms_sync payload)`,
    );
    return "malformed";
  }

  const wmsSync = resolveWmsSyncService(dbArg);
  if (!wmsSync) {
    await keepPending(
      dbArg,
      item.id,
      "WMS sync service not available on db.__wmsSyncService",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (oms_wms_sync, order=${omsOrderId}) deferred - WMS sync service unavailable`,
    );
    return "pending";
  }

  try {
    const wmsOrderId = await wmsSync.syncOmsOrderToWms(omsOrderId);
    // `null` = sync intentionally SKIPPED (order already final/fulfilled, no WMS order
    // needed) — a no-op success, NOT a failure. A genuine error THROWS (handled below).
    await markRowSuccess(dbArg, item);
    if (!wmsOrderId) {
      console.log(
        `${LOG_PREFIX} Item ${item.id} (oms_wms_sync, order=${omsOrderId}) skipped — order already final/fulfilled, no WMS order needed (no-op success)`,
      );
    } else {
      console.log(
        `${LOG_PREFIX} Item ${item.id} (oms_wms_sync, order=${omsOrderId}, wms=${wmsOrderId}) succeeded`,
      );
    }
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "oms_wms_sync", orderId: omsOrderId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (oms_wms_sync, order=${omsOrderId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (oms_wms_sync, order=${omsOrderId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

export async function dispatchWmsShipmentCreateRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { wmsOrderId?: number } | null;
  const wmsOrderId = payload?.wmsOrderId;

  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: wmsOrderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed wms_shipment_create payload)`,
    );
    return "malformed";
  }

  try {
    const orderResult = await dbArg.execute(sql`
      SELECT wo.id, wo.channel_id
      FROM wms.orders wo
      WHERE wo.id = ${wmsOrderId}
        AND wo.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship')
        AND NOT EXISTS (
          SELECT 1
          FROM wms.outbound_shipments os
          WHERE os.order_id = wo.id
            AND os.status <> 'voided'
        )
      LIMIT 1
    `);
    const orderRow = Array.isArray(orderResult?.rows) ? orderResult.rows[0] : null;
    if (!orderRow) {
      await markRowSuccess(dbArg, item);
      console.log(
        `${LOG_PREFIX} Item ${item.id} (wms_shipment_create, wms=${wmsOrderId}) no longer needs remediation`,
      );
      return "success";
    }

    const itemResult = await dbArg.execute(sql`
      SELECT id,
             quantity,
             product_id AS product_variant_id
      FROM wms.order_items
      WHERE order_id = ${wmsOrderId}
        AND COALESCE(requires_shipping, 1) <> 0
        AND COALESCE(quantity, 0) > COALESCE(fulfilled_quantity, 0)
    `);
    const shipmentItems = (Array.isArray(itemResult?.rows) ? itemResult.rows : []).map((row: any) => ({
      id: Number(row.id),
      quantity: Number(row.quantity ?? 0),
      productVariantId:
        row.product_variant_id == null ? null : Number(row.product_variant_id),
    }));

    const created = await createShipmentForOrder(
      dbArg,
      wmsOrderId,
      orderRow.channel_id == null ? null : Number(orderRow.channel_id),
      shipmentItems,
    );
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (wms_shipment_create, wms=${wmsOrderId}, shipment=${created.shipmentId}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "wms_shipment_create", orderId: wmsOrderId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (wms_shipment_create, wms=${wmsOrderId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (wms_shipment_create, wms=${wmsOrderId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

export async function dispatchShipStationShipmentPushRetry(
  dbArg: any,
  item: RetryDispatchItem,
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
      item,
      "malformed payload: shipmentId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shipstation_shipment_push payload)`,
    );
    return "malformed";
  }

  const eng = resolveShippingEngine(dbArg);
  const ssSvc = resolveShipStationService(dbArg);
  if (!eng && (!ssSvc || typeof ssSvc.pushShipment !== "function")) {
    await keepPending(
      dbArg,
      item.id,
      "shipping engine not available on db.__shippingEngine",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (shipstation_shipment_push, shipment=${shipmentId}) deferred - engine unavailable`,
    );
    return "pending";
  }

  try {
    if (eng) {
      await eng.upsertShipment({ shipmentId } as any);
    } else {
      await ssSvc!.pushShipment!(shipmentId);
    }
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (shipstation_shipment_push, shipment=${shipmentId}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    // Permanent, deterministic validation failure (bad address/total/country,
    // not-pushable status, finalized order). Don't retry — flag for review and
    // dead-letter immediately so the reconciler stops re-enqueuing it.
    if (err?.context?.code === SS_PUSH_INVALID_SHIPMENT) {
      const reason = err?.message || String(err);
      await markShipmentPushPermanentlyFailed(dbArg, item, shipmentId, reason);
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation_shipment_push, shipment=${shipmentId}) PERMANENT — flagged requires_review, not retrying: ${reason}`,
      );
      return "dead";
    }
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "shipstation_shipment_push", shipmentId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shipstation_shipment_push, shipment=${shipmentId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation_shipment_push, shipment=${shipmentId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

export async function dispatchShipStationHoldSyncRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as {
    wmsOrderId?: number;
    requestedMode?: "hold" | "release";
  } | null;
  const wmsOrderId = payload?.wmsOrderId;

  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: wmsOrderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shipstation_hold_sync payload)`,
    );
    return "malformed";
  }

  const eng = resolveShippingEngine(dbArg);
  const ssSvc = resolveShipStationService(dbArg);
  if (!eng && (!ssSvc || typeof ssSvc.syncWmsOrderShipStationHoldState !== "function")) {
    await keepPending(
      dbArg,
      item.id,
      "shipping engine not available for hold sync",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (shipstation_hold_sync, wms=${wmsOrderId}) deferred - engine unavailable`,
    );
    return "pending";
  }

  const orderResult = await dbArg.execute(sql`
    SELECT id, order_number, on_hold
    FROM wms.orders
    WHERE id = ${wmsOrderId}
    LIMIT 1
  `);
  const orderRow = Array.isArray(orderResult?.rows) ? orderResult.rows[0] : null;
  if (!orderRow) {
    await markRowDead(
      dbArg,
      item,
      `WMS order ${wmsOrderId} not found for hold sync`,
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} (shipstation_hold_sync, wms=${wmsOrderId}) moved to DLQ - WMS order not found`,
    );
    return "dead";
  }

  const mode: "hold" | "release" = Number(orderRow.on_hold) === 1 ? "hold" : "release";

  try {
    let touched = 0;
    if (eng) {
      const { engineRefFromRow } = await import("../shipping/adapters/shipstation.adapter");
      const shipments = await dbArg.execute(sql`
        SELECT shipping_engine, engine_order_ref, engine_shipment_ref,
               shipstation_order_id, shipstation_order_key
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
          AND COALESCE(engine_order_ref, shipstation_order_id::text) IS NOT NULL
          AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
      `);
      for (const row of shipments.rows ?? []) {
        const ref = engineRefFromRow(row as any);
        if (!ref) continue;
        if (mode === "hold") { await eng.hold(ref); } else { await eng.releaseHold(ref); }
        touched++;
      }
    } else {
      const result = await ssSvc!.syncWmsOrderShipStationHoldState!(wmsOrderId, mode);
      touched = result?.touched ?? 0;
    }
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (shipstation_hold_sync, wms=${wmsOrderId}, mode=${mode}, touched=${touched}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "shipstation_hold_sync", orderId: wmsOrderId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shipstation_hold_sync, wms=${wmsOrderId}, mode=${mode}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation_hold_sync, wms=${wmsOrderId}, mode=${mode}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

export async function dispatchShipStationSortRankSyncRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { wmsOrderId?: number } | null;
  const wmsOrderId = payload?.wmsOrderId;

  if (
    typeof wmsOrderId !== "number" ||
    !Number.isInteger(wmsOrderId) ||
    wmsOrderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: wmsOrderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shipstation_sort_rank_sync payload)`,
    );
    return "malformed";
  }

  const eng2 = resolveShippingEngine(dbArg);
  const ssSvc2 = resolveShipStationService(dbArg);
  if (!eng2 && (!ssSvc2 || typeof ssSvc2.updateSortRank !== "function")) {
    await keepPending(
      dbArg,
      item.id,
      "shipping engine not available for sort-rank sync",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) deferred - engine unavailable`,
    );
    return "pending";
  }

  const orderResult = await dbArg.execute(sql`
    SELECT id, order_number, sort_rank
    FROM wms.orders
    WHERE id = ${wmsOrderId}
    LIMIT 1
  `);
  const orderRow = Array.isArray(orderResult?.rows) ? orderResult.rows[0] : null;
  if (!orderRow) {
    await markRowDead(
      dbArg,
      item,
      `WMS order ${wmsOrderId} not found for sort-rank sync`,
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) moved to DLQ - WMS order not found`,
    );
    return "dead";
  }

  if (!orderRow.sort_rank) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      `WMS order ${wmsOrderId} has no sort_rank to sync`,
      { topic: "shipstation_sort_rank_sync", orderId: wmsOrderId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) moved to DLQ after ${attempts} attempts - missing sort_rank`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) missing sort_rank. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }

  try {
    let touched2 = 0;
    if (eng2) {
      const { engineRefFromRow } = await import("../shipping/adapters/shipstation.adapter");
      const shipments = await dbArg.execute(sql`
        SELECT shipping_engine, engine_order_ref, engine_shipment_ref,
               shipstation_order_id, shipstation_order_key
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
          AND COALESCE(engine_order_ref, shipstation_order_id::text) IS NOT NULL
          AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
      `);
      for (const row of shipments.rows ?? []) {
        const ref = engineRefFromRow(row as any);
        if (!ref) continue;
        await eng2.updatePriority(ref, orderRow.sort_rank);
        touched2++;
      }
    } else {
      const result = await ssSvc2!.updateSortRank!(wmsOrderId);
      touched2 = result?.touched ?? 0;
    }
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}, touched=${touched2}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "shipstation_sort_rank_sync", orderId: wmsOrderId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shipstation_sort_rank_sync, wms=${wmsOrderId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
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
  item: RetryDispatchItem,
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
      item,
      "malformed payload: shipmentId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shopify_fulfillment_push payload)`,
    );
    return "malformed";
  }

  const fulfillmentPush = resolveFulfillmentPushService(dbArg);
  if (!fulfillmentPush || typeof fulfillmentPush.pushShopifyFulfillment !== "function") {
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
    const result = await fulfillmentPush.pushShopifyFulfillment(shipmentId);
    if (result.writebackComplete !== true) {
      throw new Error(
        `Shopify fulfillment push returned without complete package coverage for shipment ${shipmentId}`,
      );
    }
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) succeeded`,
    );
    return "success";
  } catch (err: any) {
    if (isShopifyClientNotReadyError(err)) {
      await keepPending(
        dbArg,
        item.id,
        "shopify fulfillment push client not initialized",
      );
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) deferred - Shopify client not initialized`,
      );
      return "pending";
    }

    // PERMANENT failure classification (CLAUDE.md §6: never retry a permanent
    // error). ShopifyFulfillmentPushError carries a structured context.code that
    // was designed for exactly this decision and was previously ignored — every
    // error burned 5 attempts and was then re-enqueued hourly by the fulfillment
    // sweeper forever (796 dead rows for 83 shipments; one shipment reached 168).
    // SHOPIFY_PUSH_INVALID_INPUT is deterministic bad input (zero-qty items from
    // the split sync bug, missing shipment/order linkage): identical retries can
    // never succeed, so dead-letter now and flag the shipment for an operator.
    // NOTE: SHOPIFY_PUSH_NO_FULFILLMENT_ORDERS stays on the transient ladder for
    // now — it can be a void-race that a later retry genuinely resolves; its
    // smarter wait-for-void / attach-tracking handling is the next step.
    if (err?.context?.code === SHOPIFY_PUSH_INVALID_INPUT) {
      await markShopifyFulfillmentPushPermanentlyFailed(
        dbArg,
        item,
        shipmentId,
        err?.message || String(err),
      );
      console.error(
        `${LOG_PREFIX} Item ${item.id} (shopify_fulfillment_push, shipment=${shipmentId}) PERMANENT failure — dead-lettered + requires_review: ${err?.message}`,
      );
      return "dead";
    }

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
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { orderId?: number; shipmentId?: number } | null;
  const orderId = payload?.orderId;
  const shipmentId = payload?.shipmentId;

  if (
    typeof orderId !== "number" ||
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: orderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed delayed_tracking_push payload)`,
    );
    return "malformed";
  }
  if (
    shipmentId !== undefined &&
    (typeof shipmentId !== "number" ||
      !Number.isInteger(shipmentId) ||
      shipmentId <= 0)
  ) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: shipmentId invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed delayed_tracking_push shipmentId)`,
    );
    return "malformed";
  }

  const fulfillmentPush = resolveFulfillmentPushService(dbArg);
  const hasShipmentPush =
    shipmentId !== undefined &&
    typeof fulfillmentPush?.pushTrackingForShipment === "function";
  const hasOrderPush = typeof fulfillmentPush?.pushTracking === "function";
  if (!fulfillmentPush || (!hasShipmentPush && !hasOrderPush)) {
    await keepPending(
      dbArg,
      item.id,
      "fulfillment push service not available",
    );
    return "pending";
  }

  try {
    const pushed = hasShipmentPush
      ? await fulfillmentPush.pushTrackingForShipment(shipmentId)
      : await fulfillmentPush.pushTracking(orderId);
    if (!pushed) {
      throw new Error(
        hasShipmentPush
          ? `fulfillment push returned false for shipment ${shipmentId}`
          : `fulfillment push returned false for order ${orderId}`,
      );
    }
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}, shipment=${shipmentId ?? "none"}) succeeded (pushed=${pushed})`,
    );
    return "success";
  } catch (err: any) {
    if (isEbayTrackingConflictError(err)) {
      await markRowSuccess(dbArg, item);
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}, shipment=${shipmentId ?? "none"}) ` +
          "was routed to reconciliation because eBay already has a different tracking fulfillment",
      );
      return "success";
    }
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "delayed_tracking_push", orderId, shipmentId },
    );
    if (status === "dead") {
      console.error(
        `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}, shipment=${shipmentId ?? "none"}) moved to DLQ after ${attempts} attempts`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (delayed_tracking_push, order=${orderId}, shipment=${shipmentId ?? "none"}) failed. Next retry at ${nextRetryAt.toISOString()}`,
      );
    }
    return status;
  }
}

export async function dispatchEbayWebhookRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  if (!item.topic?.toLowerCase().includes("order")) {
    await markRowDead(
      dbArg,
      item,
      `unsupported eBay webhook replay topic: ${item.topic || "unknown"}`,
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (unsupported ebay webhook topic ${item.topic || "unknown"})`,
    );
    return "malformed";
  }

  const orderId = (item.payload as any)?.notification?.data?.orderId;
  if (typeof orderId !== "string" || orderId.trim().length === 0) {
    await markRowDead(
      dbArg,
      item,
      "malformed payload: notification.data.orderId missing or invalid",
    );
    console.error(
      `${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed ebay webhook payload)`,
    );
    return "malformed";
  }

  const ebayReplay = resolveEbayWebhookReplayService(dbArg);
  if (!ebayReplay) {
    await keepPending(
      dbArg,
      item.id,
      "eBay replay service not available on db.__ebayWebhookReplay",
    );
    console.warn(
      `${LOG_PREFIX} Item ${item.id} (${item.topic}, order=${orderId}) deferred - eBay replay service unavailable`,
    );
    return "pending";
  }

  try {
    const result = await ebayReplay.reingestEbayOrder(
      orderId.trim(),
      ebayReplay.omsService,
      ebayReplay.ebayApiClient,
    );
    await markRowSuccess(dbArg, item);
    console.log(
      `${LOG_PREFIX} Item ${item.id} (${item.topic}, order=${orderId}) succeeded via eBay reingest (${result.status}, oms=${result.omsOrderId})`,
    );
    return "success";
  } catch (err: any) {
    const { status, attempts, nextRetryAt } = await recordRetryFailure(
      dbArg,
      item,
      err?.message || String(err),
      { topic: "eBay Webhook" },
    );
    if (status === "dead") {
      console.error(
        `CRITICAL: eBay Webhook Dead-Lettered\nTopic: ${item.topic}\nOrder: ${orderId}\nLast Error: ${err?.message || String(err)}\nAttempts: ${attempts}\nQueue Row ID: ${item.id}`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} Item ${item.id} (${item.topic}, order=${orderId}) failed. Next retry at ${nextRetryAt.toISOString()}`,
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
  item: { id: number; attempts: number; topic?: string; payload?: any; sourceInboxId?: number | null },
  errMessage: string,
  meta: { topic?: string; orderId?: number; shipmentId?: number } = {},
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
    await mirrorRetryStatusToInbox(dbArg, item, "dead", errMessage);

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
  item: { id: number; sourceInboxId?: number | null },
  reason: string,
): Promise<void> {
  await dbArg
    .update(webhookRetryQueue)
    .set({
      status: "dead",
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(webhookRetryQueue.id, item.id));

  await mirrorRetryStatusToInbox(dbArg, item, "dead", reason);
}

/**
 * A ShipStation push failed PERMANENTLY — a deterministic validation rejection
 * (SS_PUSH_INVALID_SHIPMENT: bad address/total/country, not-pushable status,
 * orphaned/finalized order). Retrying identical data can never succeed, so per
 * CLAUDE.md §6 ("never retry a permanent error") we stop here instead of burning
 * 5 attempts and then being re-enqueued by the stale-push reconciler forever:
 *   - flag the shipment requires_review (guarded to non-terminal shipments, and
 *     only when one exists — "shipment not found" no-ops). This drops it from the
 *     SHIPMENT_NOT_PUSHED_TO_SHIPSTATION auto-retry bucket and surfaces it in the
 *     requires-review bucket. pushShipment already refuses requires_review
 *     shipments, so a human must fix the data + clear the flag to re-enter.
 *   - dead-letter the queue row immediately (markRowDead also mirrors to inbox).
 */
/**
 * A Shopify FULFILLMENT push failed PERMANENTLY (SHOPIFY_PUSH_INVALID_INPUT —
 * zero-qty items, missing shipment/order linkage). Shopify-side twin of
 * markShipmentPushPermanentlyFailed below, with one deliberate difference in the
 * status guard: fulfillment pushes target shipments that are ALREADY SHIPPED
 * (we're writing tracking back to the channel), so 'shipped' must be flaggable —
 * only cancelled/voided shipments are excluded (their push debt is moot).
 * requires_review is the single chokepoint: enqueueShopifyFulfillmentRetry skips
 * flagged shipments, which stops the sweeper/reconciler resurrection loop. The
 * operator fixes the data (e.g. repairs the zero-qty split items) and clears the
 * flag to re-enter the pipeline.
 */
async function markShopifyFulfillmentPushPermanentlyFailed(
  dbArg: any,
  item: { id: number; sourceInboxId?: number | null },
  shipmentId: number,
  reason: string,
): Promise<void> {
  if (typeof dbArg?.execute === "function") {
    // Same review_reason preservation rules as the ShipStation twin: overwrite
    // the auto-cleared inventory reason, preserve any other manual reason.
    await dbArg.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true,
          review_reason = CASE
            WHEN review_reason IS NULL
              OR review_reason = 'inventory_deduction_missing_item_data'
            THEN ${`permanent_fulfillment_push_failure: ${reason}`}
            ELSE review_reason
          END,
          updated_at = NOW()
      WHERE id = ${shipmentId}
        AND status NOT IN ('cancelled', 'voided')
    `);
  }
  await markRowDead(dbArg, item, reason);
}

async function markShipmentPushPermanentlyFailed(
  dbArg: any,
  item: { id: number; sourceInboxId?: number | null },
  shipmentId: number,
  reason: string,
): Promise<void> {
  if (typeof dbArg?.execute === "function") {
    // review_reason write is deliberate (see the two reviewed hazards):
    //   - DON'T leave/keep 'inventory_deduction_missing_item_data': the V2
    //     SHIP_NOTIFY reconciler auto-clears requires_review for exactly that
    //     reason, which would un-flag this shipment on inventory arrival and
    //     reopen the loop with the real (push) cause hidden. So overwrite it.
    //   - DO preserve any OTHER pre-existing manual reason (e.g.
    //     'refund_after_ship'): that context is still valid and shouldn't be lost.
    //   - When unset, record the namespaced permanent-push cause for ops.
    await dbArg.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true,
          review_reason = CASE
            WHEN review_reason IS NULL
              OR review_reason = 'inventory_deduction_missing_item_data'
            THEN ${`permanent_push_failure: ${reason}`}
            ELSE review_reason
          END,
          updated_at = NOW()
      WHERE id = ${shipmentId}
        AND status NOT IN ('shipped', 'cancelled', 'voided')
    `);
  }
  await markRowDead(dbArg, item, reason);
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
async function markRowSuccess(
  dbArg: any,
  item: { id: number; sourceInboxId?: number | null },
): Promise<void> {
  await dbArg
    .update(webhookRetryQueue)
    .set({ status: "success", updatedAt: new Date() })
    .where(eq(webhookRetryQueue.id, item.id));

  await mirrorRetryStatusToInbox(dbArg, item, "succeeded", null);
}

async function mirrorRetryStatusToInbox(
  dbArg: any,
  item: { id: number; sourceInboxId?: number | null },
  status: "succeeded" | "dead",
  lastError: string | null,
): Promise<void> {
  const sourceInboxId = Number(item.sourceInboxId);
  if (!Number.isInteger(sourceInboxId) || sourceInboxId <= 0) return;
  if (typeof dbArg?.execute !== "function") return;

  if (status === "succeeded") {
    await dbArg.execute(sql`
      UPDATE oms.webhook_inbox
      SET status = 'succeeded',
          last_error = NULL,
          processed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${sourceInboxId}
    `);
    return;
  }

  await dbArg.execute(sql`
    UPDATE oms.webhook_inbox
    SET status = 'dead',
        last_error = ${lastError || "retry row dead-lettered"},
        updated_at = NOW()
    WHERE id = ${sourceInboxId}
  `);
}

/**
 * Dispatch a single pending row for the shipstation provider.
 * Exported for unit testing.
 */
export async function dispatchShipStationRetry(
  dbArg: any,
  item: RetryDispatchItem,
): Promise<"success" | "pending" | "dead" | "malformed"> {
  const payload = item.payload as { resource_url?: string } | null;
  const resourceUrl = payload?.resource_url;

  if (!resourceUrl || typeof resourceUrl !== "string") {
    // Malformed row — dead-letter immediately. Retrying a missing
    // resource_url will never succeed, so burning attempts is wasteful.
    await markRowDead(dbArg, item, "malformed payload: missing resource_url");
    console.error(`${LOG_PREFIX} Item ${item.id} moved to DLQ (malformed shipstation payload)`);
    return "malformed";
  }

  const engine = resolveShippingEngine(dbArg);
  const shipStationService = engine ?? resolveShipStationService(dbArg);
  if (!shipStationService) {
    const { status } = await recordRetryFailure(
      dbArg,
      item,
      "shipping engine not available on db.__shippingEngine"
    );
    console.warn(`${LOG_PREFIX} Item ${item.id} deferred — engine unavailable (status=${status})`);
    return status;
  }

  try {
    await (engine ? engine.processWebhook(resourceUrl) : shipStationService.processShipNotify(resourceUrl));
    await markRowSuccess(dbArg, item);
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

    if (item.provider === "ebay") {
      try {
        await dispatchEbayWebhookRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} ebay dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "oms_wms_sync"
    ) {
      try {
        await dispatchOmsWmsSyncRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} oms_wms_sync dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "wms_shipment_create"
    ) {
      try {
        await dispatchWmsShipmentCreateRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} wms_shipment_create dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "shipstation_shipment_push"
    ) {
      try {
        await dispatchShipStationShipmentPushRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} shipstation_shipment_push dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "shipstation_hold_sync"
    ) {
      try {
        await dispatchShipStationHoldSyncRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} shipstation_hold_sync dispatch threw: ${branchErr?.message || branchErr}`,
        );
      }
      continue;
    }

    if (
      item.provider === "internal" &&
      item.topic === "shipstation_sort_rank_sync"
    ) {
      try {
        await dispatchShipStationSortRankSyncRetry(defaultDb, item as any);
      } catch (branchErr: any) {
        console.error(
          `${LOG_PREFIX} Item ${item.id} shipstation_sort_rank_sync dispatch threw: ${branchErr?.message || branchErr}`,
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
        await markRowDead(defaultDb, item as any, `Unknown topic: ${item.topic}`);
        continue;
      }

      try {
        console.log(`${LOG_PREFIX} Retrying shopify item ${item.id} (${item.topic}), attempt ${item.attempts + 1}`);

        const basePath = FULFILLMENT_TOPICS.has(item.topic)
          ? "/api/shopify/webhooks"
          : "/api/oms/webhooks";
        const url = `http://127.0.0.1:${process.env.PORT || 5000}${basePath}/${item.topic}`;
        const sourceHeaders = await getSourceInboxReplayHeaders(defaultDb, item.sourceInboxId);
        const payloadDomain = (item.payload as any)?.shop_domain || process.env.SHOPIFY_SHOP_DOMAIN || "echelon-wms.myshopify.com";

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-retry": secret,
            "x-shopify-shop-domain": payloadDomain,
            ...sourceHeaders,
          },
          body: JSON.stringify(item.payload),
        });

        if (res.ok) {
          await markRowSuccess(defaultDb, item as any);
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
        await markRowSuccess(defaultDb, item as any);
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
