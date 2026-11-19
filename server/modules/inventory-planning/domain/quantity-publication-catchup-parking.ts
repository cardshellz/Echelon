import { createHash } from "node:crypto";

/**
 * Catch-up failure classes (Channels PR5, PLAN-CH-v3 section 6 "Catch-up"). Pure rules; the store persists them.
 *
 * - parked: the refusal says the size has no stock link yet. Retrying every minute cannot help, so the row waits:
 *   a link of the same item wakes it (the sealer, inventory-cutover-definitions.repository.ts), and a daily re-check
 *   covers anything the wake missed.
 * - paused: a lock, fence or admission slot was busy. Nothing was tried, so no attempt is counted; retry in 1-3 min.
 * - transient: counted; min(1 min x 2^n, 1 h). WARN at 8 attempts, ERROR at 24 (needs a person), still retrying.
 * - permanent: never retried automatically; requires_review_at is set and Ops Health raises it.
 */
export type QuantityCatchupFailureClass = "parked" | "paused" | "transient" | "permanent";

/** The three missing-link refusals (plan section 6): canonical planning found no exact sealed link for the item. */
export const QUANTITY_CATCHUP_MISSING_LINK_CODES: readonly string[] = Object.freeze([
  "PUBLICATION_LISTING_TARGET_UNMAPPED",
  "PUBLICATION_LISTING_PLAN_OMITTED",
  "CANONICAL_PUBLICATION_MAPPING_MISSING",
]);

/** Busy conditions that are not this row's fault. Any namespaced code ending in _BUSY is busy too. */
export const QUANTITY_CATCHUP_BUSY_CODES: readonly string[] = Object.freeze([
  "55P03", // lock_not_available (NOWAIT / lock_timeout), e.g. the cutover fence
  "CUTOVER_CONFIGURATION_FREEZE_CHANGED", // an activation run opened its freeze
  "PUBLICATION_GLOBAL_STOP_ACTIVE", // the owner's global stop: resumes by itself when lifted
]);
const BUSY_SUFFIX = /^[A-Z][A-Z0-9_]*_BUSY$/;

/** The persisted claim no longer matches its own scope: retrying the same row cannot change that. */
export const QUANTITY_CATCHUP_PERMANENT_CODES: readonly string[] = Object.freeze([
  "PUBLICATION_CATCHUP_SCOPE_MISMATCH",
]);

export const QUANTITY_CATCHUP_PARK_RECHECK_SECONDS = 24 * 60 * 60;
/** Transient delay = min(baseSeconds x 2^n, maxSeconds), n = attempts already counted (60 s, 120 s, ... 1 h). The
 * store applies it in SQL; maxExponent bounds the power (2^6 x 60 s already exceeds the cap). */
export const QUANTITY_CATCHUP_TRANSIENT_BACKOFF = Object.freeze({ baseSeconds: 60, maxSeconds: 60 * 60, maxExponent: 6 });
export const QUANTITY_CATCHUP_PAUSED_DELAY = Object.freeze({ minSeconds: 60, maxSeconds: 180 });
export const QUANTITY_CATCHUP_ESCALATION = Object.freeze({ warnAttempts: 8, errorAttempts: 24 });

/**
 * `retryable: false` on the thrown error is the owner's explicit "this will never succeed" (e.g. a provider refusal
 * typed by PR1). Everything unrecognised stays transient: section 6 classifies only missing links, busy and
 * permanent explicitly, and a bounded backoff is the safe default for an unknown refusal.
 */
export function classifyQuantityCatchupFailure(input: { code: string; retryable?: unknown }): QuantityCatchupFailureClass {
  if (QUANTITY_CATCHUP_MISSING_LINK_CODES.includes(input.code)) return "parked";
  if (QUANTITY_CATCHUP_BUSY_CODES.includes(input.code) || BUSY_SUFFIX.test(input.code)) return "paused";
  if (input.retryable === false || QUANTITY_CATCHUP_PERMANENT_CODES.includes(input.code)) return "permanent";
  return "transient";
}

/**
 * Jitter for a paused row, derived from the row's identity instead of randomness (CLAUDE.md section 3): rows paused
 * by the same busy owner spread over 60-180 s, and the same claim always gets the same delay.
 */
export function quantityCatchupPausedDelaySeconds(claim: { catchupId: string; revision: string }): number {
  const { minSeconds, maxSeconds } = QUANTITY_CATCHUP_PAUSED_DELAY;
  const digest = createHash("sha256").update(`${claim.catchupId}:${claim.revision}`).digest();
  return minSeconds + (digest.readUInt32BE(0) % (maxSeconds - minSeconds + 1));
}

/** The log level a transient attempt count reaches: one WARN at 8, one ERROR at 24 (only on that exact attempt). */
export function quantityCatchupEscalation(attemptCount: number): "warn" | "error" | null {
  if (attemptCount === QUANTITY_CATCHUP_ESCALATION.errorAttempts) return "error";
  if (attemptCount === QUANTITY_CATCHUP_ESCALATION.warnAttempts) return "warn";
  return null;
}
