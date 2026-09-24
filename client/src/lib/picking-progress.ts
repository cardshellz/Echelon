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
 * Shipment declarations do not prove a bin/lot pick. Missing pick evidence is
 * handled by the durable corrective-picking workflow, never by this projection.
 */
export function derivePickerLineProgress(
  input: PickerLineProgressInput,
): PickerLineProgress {
  const targetQuantity = nonNegativeInteger(input.quantity);
  const pickedQuantity = Math.min(
    targetQuantity,
    nonNegativeInteger(input.pickedQuantity),
  );

  const status = input.status === "short"
    ? input.status
    : targetQuantity === 0 || pickedQuantity >= targetQuantity
      ? "completed"
      : input.status === "completed" ? "pending" : input.status;

  return { targetQuantity, pickedQuantity, status };
}
