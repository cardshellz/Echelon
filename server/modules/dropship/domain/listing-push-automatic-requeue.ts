/**
 * Automatic re-queue of listing push items the stock link failed for a reason
 * that clears by itself (plan F2 2.10, D13), plus the owner-approved one-time
 * re-send of items that failed with PUBLICATION_LISTING_TARGET_UNMAPPED before
 * the automatic stock link existed (owner decision Q4 = YES). Pure: the push
 * sweep's recovery step reads these to select, re-queue and mark items.
 *
 * Every re-queue increments the item's `automaticRequeue.count` marker, so the
 * total is bounded across codes, and each code waits longer after each re-queue.
 * An item past its code's cap is marked once and logged at ERROR (a human looks).
 */

const MINUTE_MS = 60_000;

export interface AutomaticRequeueCodePolicy {
  /** Wait after the failure before re-queue number (index + 1); its length is the cap. */
  readonly delaysMs: readonly number[];
}

/**
 * - DROPSHIP_STOCK_LINK_BUSY / PUBLICATION_SCOPE_BUSY: concurrent stock work on
 *   the same SKU outlasted the in-process retry; 1, 5 then 15 minutes.
 * - DROPSHIP_STOCK_UPDATES_PAUSED: Card Shellz paused all stock updates; 15
 *   minutes, 1 hour then 4 hours (the vendor text promises a retry and asks them
 *   to contact support after six hours).
 * - PUBLICATION_LISTING_TARGET_UNMAPPED (Q4): once, as soon as the store has one
 *   live Card Shellz stock destination and the listing is still selected. After
 *   2a-2 a managed live push links before its first write, so this code means
 *   the push failed before the link existed (or lost a race); a second refusal
 *   is not re-sent again.
 */
export const AUTOMATIC_REQUEUE_POLICY: Readonly<Record<string, AutomaticRequeueCodePolicy>> = Object.freeze({
  DROPSHIP_STOCK_LINK_BUSY: Object.freeze({ delaysMs: Object.freeze([1 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS]) }),
  PUBLICATION_SCOPE_BUSY: Object.freeze({ delaysMs: Object.freeze([1 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS]) }),
  DROPSHIP_STOCK_UPDATES_PAUSED: Object.freeze({ delaysMs: Object.freeze([15 * MINUTE_MS, 60 * MINUTE_MS, 240 * MINUTE_MS]) }),
  PUBLICATION_LISTING_TARGET_UNMAPPED: Object.freeze({ delaysMs: Object.freeze([0]) }),
});

/** The Q4 code: re-sent only after the extra eligibility checks (live destination, still selected). */
export const STOCK_LINK_RESEND_CODE = "PUBLICATION_LISTING_TARGET_UNMAPPED";

export const AUTOMATIC_REQUEUE_CODES: readonly string[] = Object.freeze(Object.keys(AUTOMATIC_REQUEUE_POLICY));

/** Recorded as the actor of every automatic re-queue, skip and exhaustion mark. */
export const AUTOMATIC_REQUEUE_ACTOR = "system:dropship-stock-link-requeue";

/**
 * Written, true, by the worker that makes the automatic stock link into the context
 * (result.push.context) of every failure it records with a code of
 * AUTOMATIC_REQUEUE_POLICY. It tells failures recorded after this deploy from those
 * recorded before it (by a worker that did not link stock first, or an old process
 * during the deploy's overlap). No clock is involved. It is read both ways:
 * - PUBLICATION_LISTING_TARGET_UNMAPPED (owner decision Q4, review MC-3): only a
 *   failure WITHOUT it is re-sent once ("failed before this deploys");
 * - every other policy code (review V2-1): only a failure WITH it is re-queued. Q4
 *   approved re-sending old failures for UNMAPPED only; an old
 *   PUBLICATION_SCOPE_BUSY failure (PR 1b told the vendor to queue it again) is
 *   the vendor's own decision, as plan F2-C01 says of old vendor intents.
 */
export const STOCK_LINK_AWARE_FAILURE_FIELD = "recordedWithAutomaticStockLink";

/** Whether the sweep's automatic re-queue owns this code (2.10 or Q4). */
export function isAutomaticRequeueCode(code: string | null | undefined): boolean {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(AUTOMATIC_REQUEUE_POLICY, code);
}

/** Whether this failure was recorded by the worker that links stock first (STOCK_LINK_AWARE_FAILURE_FIELD). */
export function isRecordedWithAutomaticStockLink(result: Record<string, unknown> | null | undefined): boolean {
  const push = result?.push;
  const context = isRecord(push) ? push.context : undefined;
  return isRecord(context) && context[STOCK_LINK_AWARE_FAILURE_FIELD] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when this run of a push item is the one the stock link re-queue queued: the
 * item's last retry request is the re-queue's own (same idempotency key, system
 * actor AUTOMATIC_REQUEUE_ACTOR). An admin retry or a vendor's new push afterwards is
 * not. Such a run never adopts a published eBay listing the vendor listing did not
 * record (review TW-1, the gate's DROPSHIP_STOCK_RESEND_LISTING_FOUND): every code
 * this policy re-queues is raised before the earlier attempt published anything, so
 * that listing is not Card Shellz's.
 */
export function isAutomaticStockLinkRequeueRun(result: Record<string, unknown> | null | undefined): boolean {
  const marker = result?.automaticRequeue;
  const last = result?.lastRetryRequest;
  if (!isRecord(marker) || !isRecord(last)) return false;
  const key = marker.idempotencyKey;
  return typeof key === "string" && key.length > 0 && last.idempotencyKey === key
    && last.actorType === "system" && last.actorId === AUTOMATIC_REQUEUE_ACTOR;
}

/** Items considered per sweep pass, so the recovery never delays the sweep's jobs for long. */
export const AUTOMATIC_REQUEUE_BATCH_SIZE = 25;

/**
 * Distinct stores whose destination is read per pass for Q4 candidates (one cheap
 * read each), oldest waiting re-send first. A store read in a recent pass and found
 * not live is excluded until its recheck time, so a backlog rotates through the
 * limit instead of starving (domain/stock-link-resend-schedule).
 */
export const AUTOMATIC_RESEND_STORE_LIMIT = 100;

/** Waiting Q4 re-sends of one store marked for review per pass when its destination cannot be read at all; the rest follow next pass. */
export const AUTOMATIC_RESEND_REVIEW_MARK_LIMIT = 500;

/** One (code, re-queues so far, wait) row per allowed re-queue, for the SQL join. */
export function automaticRequeuePolicyRows(): Array<{ code: string; count: number; delayMs: number }> {
  return AUTOMATIC_REQUEUE_CODES.flatMap(code => AUTOMATIC_REQUEUE_POLICY[code]!.delaysMs
    .map((delayMs, count) => ({ code, count, delayMs })));
}

/** How many automatic re-queues a code allows (0 for any other code). */
export function automaticRequeueCap(code: string): number {
  return AUTOMATIC_REQUEUE_POLICY[code]?.delaysMs.length ?? 0;
}

/** Stands for a marker count this code cannot read: past every cap, so never re-queued (the SQL's STOCK_LINK_REQUEUE_COUNT_SQL does the same). */
const UNREADABLE_REQUEUE_COUNT = 99_999;

/** Automatic re-queues an item already had, from its result's marker; 0 without one. */
export function automaticRequeueCountOf(result: Record<string, unknown> | null | undefined): number {
  if (!result || !("automaticRequeue" in result)) return 0;
  const marker = result.automaticRequeue;
  if (!isRecord(marker)) return UNREADABLE_REQUEUE_COUNT;
  const count = typeof marker.count === "number" ? String(marker.count) : marker.count;
  return typeof count === "string" && /^[0-9]{1,4}$/.test(count) ? Number(count) : UNREADABLE_REQUEUE_COUNT;
}

/**
 * The item-level half of "will the push sweep queue this failed item again by
 * itself" (reviews TW-3, V2-2): a code of this policy below its cap, no state mark,
 * recorded by the worker that links stock first (review V2-1). Never for
 * PUBLICATION_LISTING_TARGET_UNMAPPED: that worker's own UNMAPPED failures carry
 * STOCK_LINK_AWARE_FAILURE_FIELD and are not re-sent (owner Q4, review MC-3).
 *
 * Necessary, not sufficient: the sweep also requires its store, vendor and listing
 * guards (newest item, unchanged preview, listing not ended, store connected, ready
 * and verified, vendor active), which only the database knows. The definite answer
 * is the ops repository's readAutomaticRequeuePendingItemIds; the vendor's email and
 * portal words use that, and this only saves the read when no item can qualify.
 */
export function mayRequeueAutomatically(item: { status: string; errorCode: string | null; result: Record<string, unknown> | null }): boolean {
  if (item.status !== "failed" || !isAutomaticRequeueCode(item.errorCode) || item.errorCode === STOCK_LINK_RESEND_CODE) return false;
  const marker = item.result?.automaticRequeue;
  if (isRecord(marker) && typeof marker.state === "string" && marker.state.length > 0) return false;
  if (!isRecordedWithAutomaticStockLink(item.result)) return false;
  return automaticRequeueCountOf(item.result) < automaticRequeueCap(item.errorCode!);
}

/** When an item that failed at `failedAt` after `count` automatic re-queues may be re-queued again; null when never. */
export function automaticRequeueDueAt(code: string, count: number, failedAt: Date): Date | null {
  const delay = AUTOMATIC_REQUEUE_POLICY[code]?.delaysMs[count];
  return delay === undefined ? null : new Date(failedAt.getTime() + delay);
}
