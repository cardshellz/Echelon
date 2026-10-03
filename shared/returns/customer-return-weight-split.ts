import Decimal from "decimal.js";
import { calculateCustomerReturnProductWeight } from "./customer-return-parcel";

const Exact = Decimal.clone({ precision: 40 });
export type CustomerReturnWeightSplit =
  | { ok: true; boxes: { lineId: string; quantity: number }[][] }
  | { ok: false; reason: "invalid" | "weight_unknown" | "individual_item" | "too_many_boxes" };

/** Deterministic first-fit decreasing, allocating whole purchased units in chunks.
 * Quantities never expand into unbounded per-unit arrays. Input order and objects
 * are preserved. Rounding occurs once per complete box, as in label intake.
 */
export function splitCustomerReturnItemsByWeight(
  items: readonly { lineId: string; quantity: number; unitWeightGrams: number | null }[],
  maxWeightGrams: number, maximumBoxes: number,
): CustomerReturnWeightSplit {
  if (!Number.isSafeInteger(maxWeightGrams) || maxWeightGrams <= 0
    || !Number.isSafeInteger(maximumBoxes) || maximumBoxes <= 0 || !items.length
    || new Set(items.map(item => item.lineId)).size !== items.length) return { ok: false, reason: "invalid" };
  for (const item of items) {
    if (!item.lineId || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) return { ok: false, reason: "invalid" };
    const unit = calculateCustomerReturnProductWeight([{ quantity: 1, unitWeightGrams: item.unitWeightGrams }]);
    if (unit === null) return { ok: false, reason: "weight_unknown" };
    if (unit > maxWeightGrams) return { ok: false, reason: "individual_item" };
  }
  const boxes: { weight: Decimal; items: { lineId: string; quantity: number }[] }[] = [];
  const ordered = [...items].sort((left, right) => new Exact(right.unitWeightGrams!).comparedTo(left.unitWeightGrams!)
    || (left.lineId < right.lineId ? -1 : left.lineId > right.lineId ? 1 : 0));
  for (const item of ordered) {
    let remaining = item.quantity;
    const unitWeight = new Exact(item.unitWeightGrams!);
    for (let index = 0; remaining > 0; index++) {
      if (index === boxes.length) {
        if (boxes.length === maximumBoxes) return { ok: false, reason: "too_many_boxes" };
        boxes.push({ weight: new Exact(0), items: [] });
      }
      const box = boxes[index];
      const capacity = new Exact(maxWeightGrams).minus(box.weight).div(unitWeight).floor();
      const quantity = Exact.min(capacity, remaining).toNumber();
      if (quantity <= 0) continue;
      box.items.push({ lineId: item.lineId, quantity });
      box.weight = box.weight.plus(unitWeight.times(quantity));
      remaining -= quantity;
    }
  }
  return { ok: true, boxes: boxes.map(box => box.items) };
}
