import { AppError, IntegrityError } from "@shared/errors";
export interface ReservedTransferGroup {
  orderItemId: number;
  quantity: number;
}
const MAX_POSTGRES_INTEGER = 2147483647;
// Whole-line selection is a bounded subset search. Never allow unusual demand
// quantities to turn a synchronous stock command into unbounded work.
const MAX_SELECTION_STATES = 20000;
interface Selection {
  group: ReservedTransferGroup;
  previous: Selection | null;
}
/** Canonical picking pins a line to its first picked bin. Move whole untouched
 * lines, then fill the remainder with free stock. The explicit confirmation may
 * move more than the minimum spillover (a 3-unit line instead of splitting 1+2).
 */
export function selectReservedTransferGroups(groups: readonly ReservedTransferGroup[], quantity: number, available: number): readonly ReservedTransferGroup[] {
  const validInteger = (value: number): boolean => Number.isSafeInteger(value)
    && value >= 0 && value <= MAX_POSTGRES_INTEGER;
  if (!validInteger(quantity) || quantity === 0 || !validInteger(available)
    || groups.some(group => !validInteger(group.quantity) || group.quantity === 0
      || !validInteger(group.orderItemId) || group.orderItemId === 0)
    || new Set(groups.map(group => group.orderItemId)).size !== groups.length) {
    throw new IntegrityError("Reserved transfer quantities or order identities are invalid");
  }
  const minimum = Math.max(0, quantity - available);
  if (minimum === 0)
    return [];
  const selections = new Map<number, Selection | null>([[0, null]]);
  for (const group of groups) {
    // Snapshot the prior states so this line is never selected twice.
    for (const [subtotal, previous] of [...selections]) {
      const total = subtotal + group.quantity;
      if (total > quantity)
        continue;
      const selection: Selection = {
        group, previous
      };
      if (total >= minimum) {
        const result: ReservedTransferGroup[] = [];
        for (let current: Selection | null = selection; current; current = current.previous) {
          result.push(current.group);
        }
        return result.reverse();
      }
      if (!selections.has(total))
        selections.set(total, selection);
      if (selections.size > MAX_SELECTION_STATES) {
        throw new AppError("There are too many whole-line combinations for this quantity. Transfer the full bin quantity or review its orders first.", "TRANSFER_RESERVATION_SELECTION_LIMIT", 409);
      }
    }
  }
  throw new AppError("This quantity would split a reserved pick line between bins. Transfer the complete unpicked line quantity instead.", "TRANSFER_WHOLE_PICK_LINE_REQUIRED", 409, {
    quantity, available, reservedLineQuantities: groups.map(group => group.quantity)
  });
}
