export type ReconciledWmsOrderItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface ReconciledWmsOrderItemProgress {
  authorityQuantity: number;
  pickedQuantity: number;
  fulfilledQuantity: number;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Recalculate the operational line status after channel authority changes.
 *
 * The caller must separately reject authority quantities below already-picked
 * quantities. Increasing a previously-completed line reopens it so the new
 * units return to picking instead of remaining hidden behind `completed`.
 */
export function deriveReconciledWmsOrderItemStatus(
  progress: ReconciledWmsOrderItemProgress,
): ReconciledWmsOrderItemStatus {
  assertNonNegativeInteger(progress.authorityQuantity, "authorityQuantity");
  assertNonNegativeInteger(progress.pickedQuantity, "pickedQuantity");
  assertNonNegativeInteger(progress.fulfilledQuantity, "fulfilledQuantity");

  if (progress.authorityQuantity === 0) {
    return "cancelled";
  }
  if (
    progress.fulfilledQuantity >= progress.authorityQuantity ||
    progress.pickedQuantity >= progress.authorityQuantity
  ) {
    return "completed";
  }
  if (progress.fulfilledQuantity > 0 || progress.pickedQuantity > 0) {
    return "in_progress";
  }
  return "pending";
}
