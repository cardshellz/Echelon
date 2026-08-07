/**
 * Dropship RMA state machine (design spec D4; build spec B2).
 *
 * Pure domain logic: the allowed-transition map plus transition guards.
 * Enforcement happens in the application service + repository; keeping the map
 * here makes the full matrix unit-testable without a database.
 *
 * Locked rules (D4):
 * - Statuses: requested, in_transit, received, inspecting, approved, rejected,
 *   disputed, credited, closed, no_inspection_review.
 * - No backward transitions. Corrections are new adjustment events, never a
 *   status rewind.
 * - `credited` is system-written only, after the ledger commits.
 * - rejected, no_inspection_review→closed, and disputed→closed require a
 *   reason code and an actor.
 * - requested→closed is the no-ship timeout path (default 14 days,
 *   policy-configurable via the B1 return policy row).
 * - Every transition is audited with the policy version that governed the RMA.
 */

export const DROPSHIP_RMA_STATUSES = [
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "disputed",
  "credited",
  "closed",
  "no_inspection_review",
] as const;

export type DropshipRmaMachineStatus = (typeof DROPSHIP_RMA_STATUSES)[number];

export type DropshipRmaTransitionActorType = "vendor" | "admin" | "system";

export interface DropshipRmaTransitionRequest {
  from: DropshipRmaMachineStatus;
  to: DropshipRmaMachineStatus;
  actor: {
    actorType: DropshipRmaTransitionActorType;
    actorId?: string | null;
  };
  /** Reason/notes for the transition. Required for denial + rejection paths. */
  reason?: string | null;
  /** True when the transition is written by the post-ledger system path. */
  systemLedgerCommit?: boolean;
}

export interface DropshipRmaTransitionDecision {
  allowed: boolean;
  /** Machine-readable rejection reason when allowed = false. */
  violation:
    | "illegal_transition"
    | "credited_requires_system_ledger"
    | "reason_required"
    | "actor_required"
    | null;
}

/**
 * The D4 transition map. Each key lists the statuses reachable from it.
 * Terminal-ish states map to empty arrays.
 */
export const DROPSHIP_RMA_TRANSITIONS: Readonly<
  Record<DropshipRmaMachineStatus, readonly DropshipRmaMachineStatus[]>
> = Object.freeze({
  requested: ["in_transit", "no_inspection_review", "closed"],
  in_transit: ["received", "no_inspection_review"],
  received: ["inspecting"],
  inspecting: ["approved", "rejected"],
  approved: ["credited"],
  rejected: ["disputed", "closed"],
  disputed: ["credited", "closed"],
  no_inspection_review: ["credited", "closed"],
  credited: ["closed"],
  closed: [],
});

/** Transitions that require a non-empty reason (D4). */
const REASON_REQUIRED_TRANSITIONS: ReadonlySet<string> = new Set([
  "inspecting->rejected",
  "no_inspection_review->closed",
  "disputed->closed",
]);

/** Transitions that may only be written by the post-ledger system path. */
const SYSTEM_LEDGER_ONLY_TARGETS: ReadonlySet<DropshipRmaMachineStatus> = new Set([
  "credited",
]);

export function isDropshipRmaTransitionLegal(
  from: DropshipRmaMachineStatus,
  to: DropshipRmaMachineStatus,
): boolean {
  return (DROPSHIP_RMA_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * Evaluate a transition request against the D4 rules. Pure function — the
 * caller is responsible for loading the current status and persisting the
 * decision.
 */
export function evaluateDropshipRmaTransition(
  request: DropshipRmaTransitionRequest,
): DropshipRmaTransitionDecision {
  if (!isDropshipRmaTransitionLegal(request.from, request.to)) {
    return { allowed: false, violation: "illegal_transition" };
  }

  if (
    SYSTEM_LEDGER_ONLY_TARGETS.has(request.to)
    && !(request.actor.actorType === "system" && request.systemLedgerCommit === true)
  ) {
    return { allowed: false, violation: "credited_requires_system_ledger" };
  }

  const transitionKey = `${request.from}->${request.to}`;
  if (REASON_REQUIRED_TRANSITIONS.has(transitionKey)) {
    const reason = typeof request.reason === "string" ? request.reason.trim() : "";
    if (!reason) {
      return { allowed: false, violation: "reason_required" };
    }
    if (!request.actor.actorId || !request.actor.actorId.trim()) {
      return { allowed: false, violation: "actor_required" };
    }
  }

  return { allowed: true, violation: null };
}

/**
 * No-ship timeout (D4): a `requested` RMA whose return never ships closes
 * automatically after the policy-configured window (default 14 days).
 */
export const DROPSHIP_RMA_DEFAULT_NO_SHIP_TIMEOUT_DAYS = 14;

export function isDropshipRmaNoShipTimedOut(input: {
  requestedAt: Date;
  now: Date;
  noShipTimeoutDays: number;
}): boolean {
  const timeoutMs = input.noShipTimeoutDays * 86_400_000;
  return input.now.getTime() - input.requestedAt.getTime() >= timeoutMs;
}
