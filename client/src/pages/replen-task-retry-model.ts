/**
 * Which blocked replenishment tasks an operator may return to the queue, and
 * what that request looks like.
 *
 * When an automatic replenishment fails mid-execution the service marks the
 * task `blocked` and records why (see `blockTaskExecutionFailure`). A blocked
 * task never retries itself, and it still counts as the active task for its
 * pick bin, so nothing creates a replacement either: the bin silently stops
 * being refilled until someone clears the task. The API has always allowed
 * `blocked -> pending`, but the Replenishment page offered no control for it,
 * so the only visible action was Cancel.
 *
 * Not every blocked task should be retried, which is why this lives here as a
 * pure rule rather than inline in the view:
 *   - a task waiting on an upstream task heals itself when that one completes,
 *     so a manual retry could run it out of order;
 *   - a no-source review sentinel carries no quantity to move, so there is
 *     nothing to redo;
 *   - a task with no target quantity would move nothing.
 */

export const BLOCKED_REPLEN_STATUS = "blocked";
export const QUEUED_REPLEN_STATUS = "pending";

/** The task fields the retry decision depends on. */
export type RetryableReplenTask = {
  status: string;
  qtySourceUnits: number;
  qtyTargetUnits: number;
  exceptionReason: string | null;
  dependsOnTaskId: number | null;
};

/**
 * Sentinel reasons the service uses to park a task for human review when it
 * cannot find any source to pull from. These carry zero quantities.
 */
const NO_SOURCE_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "no_source_stock",
  "no_source_variant",
]);

/**
 * A review-only marker rather than real queued work: blocked, carrying no
 * quantity on either side, with no upstream dependency, parked because no
 * source could be resolved.
 */
export function isNoSourceReviewOnlyTask(task: RetryableReplenTask): boolean {
  return (
    task.status === BLOCKED_REPLEN_STATUS &&
    task.qtySourceUnits <= 0 &&
    task.qtyTargetUnits <= 0 &&
    !task.dependsOnTaskId &&
    NO_SOURCE_REVIEW_REASONS.has(task.exceptionReason ?? "")
  );
}

/** True when returning this task to the queue is a sound, useful action. */
export function canRetryReplenTask(task: RetryableReplenTask): boolean {
  if (task.status !== BLOCKED_REPLEN_STATUS) return false;
  // Dependency-blocked tasks are released automatically when the upstream task
  // completes. Forcing one back to pending would let it run out of order.
  if (task.dependsOnTaskId != null) return false;
  if (isNoSourceReviewOnlyTask(task)) return false;
  // Nothing to put away means nothing to retry.
  if (task.qtyTargetUnits <= 0) return false;
  return true;
}

/**
 * The PATCH body that re-queues a task. The failure is cleared from
 * `exceptionReason` so the task reads as ordinary queued work, while `notes`
 * is deliberately left alone: it holds the recorded failure history and that
 * trail must survive the retry.
 */
export function buildReplenTaskRetryRequest(): {
  status: typeof QUEUED_REPLEN_STATUS;
  exceptionReason: null;
} {
  return { status: QUEUED_REPLEN_STATUS, exceptionReason: null };
}
