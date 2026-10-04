/**
 * Which vendor notice a failed tracking push sends.
 *
 * The vendor hears about one push at most twice (owner decision 2026-10-04):
 * once when it first fails and will be retried, and once when it fails for
 * good. The retries in between send nothing; every failure is still recorded
 * on the push row and in the dropship audit log. Pure.
 */
export type TrackingFailureNotice = "retrying" | "failed" | "none";

export interface TrackingFailureNoticeInput {
  /** Whether the failure itself could succeed on another attempt. */
  readonly retryable: boolean;
  /** The push's attempt count including the attempt that just failed (1 = first). */
  readonly attemptCount: number;
  /** The caller will not try this push again. */
  readonly lastAttempt: boolean;
}

export function decideTrackingFailureNotice(input: TrackingFailureNoticeInput): TrackingFailureNotice {
  if (!input.retryable || input.lastAttempt) return "failed";
  // An unreadable count is treated as a first failure: telling the vendor
  // once too often is safer than never telling them.
  const laterAttempt = Number.isSafeInteger(input.attemptCount) && input.attemptCount > 1;
  return laterAttempt ? "none" : "retrying";
}
