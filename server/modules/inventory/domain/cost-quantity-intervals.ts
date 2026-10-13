import { allocateIntegerCostInterval } from "@shared/utils/integer-cost-interval";

export interface CostQuantityInterval {
  start: number;
  quantity: number;
}

function integer(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`Invalid ${name}`);
}

export function validateCostQuantityIntervals(
  intervals: readonly CostQuantityInterval[],
  basis: number,
): void {
  integer(basis, "cost quantity basis", 1);
  let end = 0;
  for (const interval of [...intervals].sort(
    (left, right) => left.start - right.start,
  )) {
    integer(interval.start, "interval start", 0);
    integer(interval.quantity, "interval quantity", 1);
    if (
      interval.start < end ||
      BigInt(interval.start) + BigInt(interval.quantity) > BigInt(basis)
    ) {
      throw new RangeError(
        "Cost quantity intervals overlap or exceed the original lot quantity",
      );
    }
    end = interval.start + interval.quantity;
  }
}

/** First-free interval assignment is deterministic under the lot/graph lock.
 * Reversals release their original intervals, so a repick cannot double-charge
 * a rounding remainder or depend on a rounded average unit price.
 */
export function takeCostQuantityIntervals(
  basis: number,
  occupied: readonly CostQuantityInterval[],
  quantity: number,
): CostQuantityInterval[] {
  validateCostQuantityIntervals(occupied, basis);
  integer(quantity, "allocated quantity", 1);
  let start = 0;
  let remaining = quantity;
  const allocated: CostQuantityInterval[] = [];
  const sorted = [...occupied].sort((left, right) => left.start - right.start);
  for (const interval of [...sorted, { start: basis, quantity: 0 }]) {
    const take = Math.min(remaining, interval.start - start);
    if (take > 0) {
      allocated.push({ start, quantity: take });
      remaining -= take;
    }
    if (remaining === 0) return allocated;
    start = interval.start + interval.quantity;
  }
  throw new RangeError(
    "Recorded cost allocations exceed the original lot quantity",
  );
}

export function subtractCostQuantityIntervals(
  original: readonly CostQuantityInterval[],
  removed: readonly CostQuantityInterval[],
  basis: number,
): CostQuantityInterval[] {
  validateCostQuantityIntervals(original, basis);
  validateCostQuantityIntervals(removed, basis);
  const remaining = original.map((interval) => ({ ...interval }));
  for (const removal of removed) {
    const index = remaining.findIndex(
      (interval) =>
        interval.start <= removal.start &&
        interval.start + interval.quantity >= removal.start + removal.quantity,
    );
    if (index < 0)
      throw new RangeError(
        "Cost reversal does not belong to its original allocation",
      );
    const interval = remaining[index];
    const before = removal.start - interval.start;
    const after =
      interval.start + interval.quantity - removal.start - removal.quantity;
    remaining.splice(
      index,
      1,
      ...(before > 0 ? [{ start: interval.start, quantity: before }] : []),
      ...(after > 0
        ? [{ start: removal.start + removal.quantity, quantity: after }]
        : []),
    );
  }
  return remaining.sort((left, right) => left.start - right.start);
}

export function sliceCostQuantityIntervals(
  original: readonly CostQuantityInterval[],
  offset: number,
  quantity: number,
): CostQuantityInterval[] {
  integer(offset, "allocation offset", 0);
  integer(quantity, "allocation quantity", 1);
  let skip = offset;
  let remaining = quantity;
  const result: CostQuantityInterval[] = [];
  for (const interval of original) {
    if (skip >= interval.quantity) {
      skip -= interval.quantity;
      continue;
    }
    const take = Math.min(remaining, interval.quantity - skip);
    result.push({ start: interval.start + skip, quantity: take });
    remaining -= take;
    skip = 0;
    if (remaining === 0) return result;
  }
  throw new RangeError("Cost allocation slice exceeds its original quantity");
}

export function intersectCostQuantityIntervals(
  left: readonly CostQuantityInterval[],
  right: readonly CostQuantityInterval[],
): CostQuantityInterval[] {
  const intersections: CostQuantityInterval[] = [];
  for (const first of left)
    for (const second of right) {
      const start = Math.max(first.start, second.start);
      const end = Math.min(
        first.start + first.quantity,
        second.start + second.quantity,
      );
      if (end > start) intersections.push({ start, quantity: end - start });
    }
  return intersections.sort((first, second) => first.start - second.start);
}

export function costForQuantityIntervals(
  total: bigint,
  basis: number,
  intervals: readonly CostQuantityInterval[],
): bigint {
  validateCostQuantityIntervals(intervals, basis);
  return intervals.reduce(
    (sum, interval) =>
      sum +
      allocateIntegerCostInterval(
        total,
        BigInt(basis),
        BigInt(interval.start),
        BigInt(interval.quantity),
      ),
    BigInt(0),
  );
}
