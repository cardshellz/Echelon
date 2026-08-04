import { MarketplaceListingReplacementError } from "./errors";

export const LISTING_PUBLICATION_STATUSES = [
  "planned",
  "staged",
  "active",
  "superseded",
  "withdrawn",
  "failed",
] as const;
export type ListingPublicationStatus =
  (typeof LISTING_PUBLICATION_STATUSES)[number];

export const LISTING_REPLACEMENT_OPERATION_STATUSES = [
  "planned",
  "running",
  "compensating",
  "completed",
  "failed",
  "manual_recovery_required",
  "cancelled",
] as const;
export type ListingReplacementOperationStatus =
  (typeof LISTING_REPLACEMENT_OPERATION_STATUSES)[number];

export const LISTING_REPLACEMENT_PHASES = [
  "preflight",
  "cutover",
  "publish",
  "verify",
  "switch_mapping",
  "compensate",
  "complete",
] as const;
export type ListingReplacementPhase =
  (typeof LISTING_REPLACEMENT_PHASES)[number];

export const LISTING_REPLACEMENT_STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export type ListingReplacementStepStatus =
  (typeof LISTING_REPLACEMENT_STEP_STATUSES)[number];

const PUBLICATION_TRANSITIONS: Readonly<
  Record<ListingPublicationStatus, readonly ListingPublicationStatus[]>
> = {
  planned: ["staged", "failed"],
  staged: ["active", "failed"],
  active: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
  failed: [],
};

const OPERATION_TRANSITIONS: Readonly<
  Record<
    ListingReplacementOperationStatus,
    readonly ListingReplacementOperationStatus[]
  >
> = {
  planned: ["running", "cancelled"],
  running: ["compensating", "completed", "failed", "manual_recovery_required"],
  compensating: ["failed", "manual_recovery_required"],
  completed: [],
  failed: [],
  manual_recovery_required: ["running", "compensating"],
  cancelled: [],
};

const PHASE_TRANSITIONS: Readonly<
  Record<ListingReplacementPhase, readonly ListingReplacementPhase[]>
> = {
  preflight: ["cutover", "compensate"],
  cutover: ["publish", "compensate"],
  publish: ["verify", "compensate"],
  verify: ["switch_mapping", "compensate"],
  switch_mapping: ["complete", "compensate"],
  compensate: [],
  complete: [],
};

const STEP_TRANSITIONS: Readonly<
  Record<ListingReplacementStepStatus, readonly ListingReplacementStepStatus[]>
> = {
  pending: ["running"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: ["running"],
};

/**
 * Checks only the local status-graph edge. It does not authorize an aggregate
 * transition; publication evidence and related replacement state still apply.
 */
export function isLocalListingPublicationStatusEdgeAllowed(
  from: ListingPublicationStatus,
  to: ListingPublicationStatus,
): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

export function assertLocalListingPublicationStatusEdgeAllowed(
  from: ListingPublicationStatus,
  to: ListingPublicationStatus,
): void {
  if (!isLocalListingPublicationStatusEdgeAllowed(from, to)) {
    throw invalidTransition("publication", from, to);
  }
}

/**
 * Checks only the local operation status edge. Phase, step, publication,
 * lease, and evidence invariants must be authorized by an aggregate writer.
 */
export function isLocalListingReplacementOperationStatusEdgeAllowed(
  from: ListingReplacementOperationStatus,
  to: ListingReplacementOperationStatus,
): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function assertLocalListingReplacementOperationStatusEdgeAllowed(
  from: ListingReplacementOperationStatus,
  to: ListingReplacementOperationStatus,
): void {
  if (!isLocalListingReplacementOperationStatusEdgeAllowed(from, to)) {
    throw invalidTransition("operation", from, to);
  }
}

/** Checks only phase adjacency, without authorizing the aggregate transition. */
export function isLocalListingReplacementPhaseEdgeAllowed(
  from: ListingReplacementPhase,
  to: ListingReplacementPhase,
): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export function assertLocalListingReplacementPhaseEdgeAllowed(
  from: ListingReplacementPhase,
  to: ListingReplacementPhase,
): void {
  if (!isLocalListingReplacementPhaseEdgeAllowed(from, to)) {
    throw invalidTransition("phase", from, to);
  }
}

/**
 * Checks only the local step status edge. Parent-operation phase, attempts,
 * evidence, and concurrency guards remain mandatory aggregate invariants.
 */
export function isLocalListingReplacementStepStatusEdgeAllowed(
  from: ListingReplacementStepStatus,
  to: ListingReplacementStepStatus,
): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertLocalListingReplacementStepStatusEdgeAllowed(
  from: ListingReplacementStepStatus,
  to: ListingReplacementStepStatus,
): void {
  if (!isLocalListingReplacementStepStatusEdgeAllowed(from, to)) {
    throw invalidTransition("step", from, to);
  }
}

function invalidTransition(
  lifecycle: "publication" | "operation" | "phase" | "step",
  from: string,
  to: string,
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_INVALID_TRANSITION",
    `Marketplace listing replacement ${lifecycle} cannot transition from ${from} to ${to}.`,
    { lifecycle, from, to },
  );
}
