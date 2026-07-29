export type PickerLineStatus = "pending" | "in_progress" | "completed" | "short";

export interface PickerLineProgressInput {
  quantity: number;
  pickedQuantity: number;
  fulfilledQuantity: number;
  status: PickerLineStatus;
}

export interface PickerLineProgress {
  targetQuantity: number;
  pickedQuantity: number;
  status: PickerLineStatus;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Picking progress is cumulative against the authorized WMS line quantity.
 * Fulfilled quantity is already a subset of picked quantity, so it can prove
 * the minimum picked quantity but must never be subtracted from the pick target.
 */
export function derivePickerLineProgress(
  input: PickerLineProgressInput,
): PickerLineProgress {
  const targetQuantity = nonNegativeInteger(input.quantity);
  const pickedQuantity = Math.min(
    targetQuantity,
    Math.max(
      nonNegativeInteger(input.pickedQuantity),
      nonNegativeInteger(input.fulfilledQuantity),
    ),
  );

  const status = input.status === "short" || input.status === "completed"
    ? input.status
    : targetQuantity === 0 || pickedQuantity >= targetQuantity
      ? "completed"
      : input.status;

  return { targetQuantity, pickedQuantity, status };
}
