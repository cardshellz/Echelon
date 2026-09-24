import { customerReturnFlowReviewInputSchema } from "../../../../shared/returns/customer-return-flow.contract";
import {
  calculateCustomerReturnProductWeight, sameCustomerReturnDimensions,
  type CustomerReturnBoxOption,
} from "../../../../shared/returns/customer-return-parcel";

const planSchema = customerReturnFlowReviewInputSchema.pick({ selections: true, parcels: true });
export class CustomerReturnBoxPlanError extends Error {
  constructor(readonly kind: "selection" | "quantity" | "parcels" | "weight", message: string) {
    super(message);
    this.name = "CustomerReturnBoxPlanError";
  }
}

/** Shared sample/live conservation check. This validates a plan without reserving units. */
export function validateCustomerReturnBoxPlan(
  lines: ReadonlyArray<{ id: string; title: string; eligibleQuantity: number; unitWeightGrams: number | null }>,
  raw: unknown,
  boxOptions: readonly CustomerReturnBoxOption[] = [],
) {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new CustomerReturnBoxPlanError("selection", "Choose valid items and quantities.");
  const input = parsed.data;
  const available = new Map(lines.map(line => [line.id, line]));
  const selections = new Map<string, { title: string; quantity: number }>();
  let selectedQuantity = 0;
  for (const selection of input.selections) {
    const line = available.get(selection.lineId);
    if (!line || selections.has(selection.lineId)) {
      throw new CustomerReturnBoxPlanError("selection", "Choose each available order line once.");
    }
    if (selection.quantity > line.eligibleQuantity) {
      throw new CustomerReturnBoxPlanError("quantity", "The selected quantity is not available to return.");
    }
    selectedQuantity += selection.quantity;
    if (!Number.isSafeInteger(selectedQuantity)) {
      throw new CustomerReturnBoxPlanError("selection", "The selected quantity is too large.");
    }
    selections.set(selection.lineId, { title: line.title, quantity: selection.quantity });
  }
  const packedQuantities = new Map<string, number>();
  const parcels = input.parcels.map((parcel, index) => {
    if (parcel.originalBoxId !== null) {
      const original = boxOptions.find(box => box.id === parcel.originalBoxId);
      if (!original || !sameCustomerReturnDimensions(original.dimensions, parcel.dimensions)) {
        throw new CustomerReturnBoxPlanError("parcels", "The original box size changed. Choose the box size again.");
      }
    }
    const linesInParcel = new Set<string>();
    const items = parcel.items.map(item => {
      const selection = selections.get(item.lineId);
      if (!selection || linesInParcel.has(item.lineId)) {
        throw new CustomerReturnBoxPlanError("parcels", "Each box must contain selected items, with each line listed once per box.");
      }
      linesInParcel.add(item.lineId);
      const packed = packedQuantities.get(item.lineId) ?? 0;
      // Subtract before adding so safe-integer inputs cannot overflow or borrow another line's units.
      if (item.quantity > selection.quantity - packed) {
        throw new CustomerReturnBoxPlanError("parcels", "The boxes contain more items than the selected quantity.");
      }
      packedQuantities.set(item.lineId, packed + item.quantity);
      return { lineId: item.lineId, title: selection.title, quantity: item.quantity };
    });
    const weightGrams = calculateCustomerReturnProductWeight(items.map(item => ({
      quantity: item.quantity, unitWeightGrams: available.get(item.lineId)!.unitWeightGrams,
    })));
    if (weightGrams === null) {
      throw new CustomerReturnBoxPlanError("weight", `The product weight for box ${index + 1} needs verification. Contact us for help with your return.`);
    }
    return { number: index + 1, items, dimensions: { ...parcel.dimensions }, weightGrams };
  });
  for (const [lineId, selection] of selections) {
    if (packedQuantities.get(lineId) !== selection.quantity) {
      throw new CustomerReturnBoxPlanError("parcels", "Place every selected item into a box before reviewing.");
    }
  }
  return { selectedQuantity, parcels };
}
