import { z } from "zod";
import type { OrderEditDiscount } from "@shared/order-edits/order-edit-discounts";
import { OrderEditError } from "./order-edit-error";
import { sumOrderEditCents } from "./order-edit-financials";

const cents = z.number().int().safe().nonnegative();
const identity = z.string().min(1).max(500);
// Matches the adapter's bounded Shopify connections; a line may have one
// observation per original discount. Duplicates are rejected below.
const MAX_ORDER_ITEMS = 250;
const MAX_ORDER_DISCOUNTS = 250;
const value = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("percentage"),
      percentage: z
        .string()
        .regex(/^\d+(?:\.\d+)?$/)
        .max(100),
    })
    .strict(),
  z.object({ type: z.literal("fixed"), amountCents: cents }).strict(),
]);
const inputSchema = z
  .object({
    rules: z
      .array(z.object({ key: identity, label: identity, value }).strict())
      .max(MAX_ORDER_DISCOUNTS),
    // Subtotals are AFTER verified product/member discounts, BEFORE order discounts.
    lines: z
      .array(z.object({ id: identity, subtotalCents: cents }).strict())
      .max(MAX_ORDER_ITEMS),
    observations: z
      .array(
        z
          .object({
            lineId: identity,
            ruleKey: identity,
            amountCents: cents,
          })
          .strict(),
      )
      .max(MAX_ORDER_ITEMS * MAX_ORDER_DISCOUNTS)
      .optional(),
  })
  .strict();
export type OrderEditDiscountEngineInput = z.infer<typeof inputSchema>;
export interface OrderEditDiscountAllocation {
  lineId: string;
  ruleKey: string;
  amountCents: number;
}
export interface OrderEditDiscountResult {
  subtotalBeforeOrderDiscountsCents: number;
  orderDiscountCents: number;
  subtotalAfterOrderDiscountsCents: number;
  discounts: OrderEditDiscount[];
  allocations: OrderEditDiscountAllocation[];
  unusedFixedCredits: Array<{
    ruleKey: string;
    label: string;
    amountCents: number;
  }>;
}

function reject(code: string, message: string): never {
  throw new OrderEditError(code, message);
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    reject(
      "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID",
      `Duplicate ${label} in discount evidence.`,
    );
}
function asCents(amount: bigint): number {
  if (amount < BigInt(0) || amount > BigInt(Number.MAX_SAFE_INTEGER))
    reject(
      "ORDER_EDIT_MONEY_INVALID",
      "Discount amounts exceed the supported integer-cent range.",
    );
  return Number(amount);
}
function fraction(percentage: string): {
  numerator: bigint;
  denominator: bigint;
} {
  const [whole, decimals = ""] = percentage.split(".");
  const scale = BigInt(`1${"0".repeat(decimals.length)}`);
  const numerator = BigInt(whole + decimals);
  if (numerator > BigInt(100) * scale)
    reject(
      "ORDER_EDIT_DISCOUNT_VALUE_INVALID",
      "A discount percentage must be between 0 and 100.",
    );
  return { numerator, denominator: BigInt(100) * scale };
}
function roundedRange(
  baseCents: number,
  percentage: string,
): { floor: number; ceil: number; nearest: number } {
  const ratio = fraction(percentage);
  const numerator = BigInt(baseCents) * ratio.numerator;
  const floor = numerator / ratio.denominator;
  const remainder = numerator % ratio.denominator;
  return {
    floor: asCents(floor),
    ceil: asCents(floor + (remainder > BigInt(0) ? BigInt(1) : BigInt(0))),
    nearest: asCents(
      floor +
        (remainder * BigInt(2) >= ratio.denominator ? BigInt(1) : BigInt(0)),
    ),
  };
}
function allocationKey(lineId: string, ruleKey: string): string {
  return JSON.stringify([lineId, ruleKey]);
}

/** Exact proportional allocation with stable identity-based penny distribution. */
function allocateFixed(
  amountCents: number,
  lines: readonly { id: string; capacityCents: number }[],
): Map<string, number> {
  const total = sumOrderEditCents(lines.map((line) => line.capacityCents));
  if (amountCents > total)
    reject(
      "ORDER_EDIT_DISCOUNT_OVERALLOCATED",
      "A fixed discount exceeds its eligible items.",
    );
  if (total === 0) return new Map(lines.map((line) => [line.id, 0]));
  const shares = lines.map((line) => {
    const numerator = BigInt(amountCents) * BigInt(line.capacityCents);
    return {
      id: line.id,
      amountCents: asCents(numerator / BigInt(total)),
      remainder: numerator % BigInt(total),
    };
  });
  let remaining =
    amountCents - sumOrderEditCents(shares.map((share) => share.amountCents));
  // Never rely on locale, input order, floating point, or the system clock.
  shares.sort((left, right) =>
    left.remainder !== right.remainder
      ? left.remainder > right.remainder
        ? -1
        : 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0,
  );
  for (const share of shares) {
    if (remaining === 0) break;
    share.amountCents++;
    remaining--;
  }
  return new Map(shares.map((share) => [share.id, share.amountCents]));
}

/**
 * Prices only discounts already applied to the order. The adapter proves each
 * rule's identity, scope and value against Shopify before invoking this engine.
 * Stacking preserves that accepted combination: percentages share the same
 * post-product-discount base; fixed credits are single budgets across the order.
 * An observed percentage may use either adjacent cent, but never a wider
 * tolerance. Fixed credit totals must match exactly, even when quantities change.
 */
export function priceOrderEditDiscounts(
  input: OrderEditDiscountEngineInput,
): OrderEditDiscountResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    reject(
      "ORDER_EDIT_DISCOUNT_INPUT_INVALID",
      "Discount rules, allocations and item amounts must be complete and valid.",
    );
  const { rules, lines, observations } = parsed.data;
  unique(
    rules.map((rule) => rule.key),
    "discount identities",
  );
  unique(
    lines.map((line) => line.id),
    "item identities",
  );
  unique(
    (observations ?? []).map((entry) =>
      allocationKey(entry.lineId, entry.ruleKey),
    ),
    "item discount allocations",
  );
  const ruleKeys = new Set(rules.map((rule) => rule.key));
  const lineIds = new Set(lines.map((line) => line.id));
  if (
    observations?.some(
      (entry) => !ruleKeys.has(entry.ruleKey) || !lineIds.has(entry.lineId),
    )
  )
    reject(
      "ORDER_EDIT_DISCOUNT_IDENTITY_INVALID",
      "An allocation references an unknown item or discount.",
    );
  const observed = new Map(
    (observations ?? []).map((entry) => [
      allocationKey(entry.lineId, entry.ruleKey),
      entry.amountCents,
    ]),
  );
  const allocatedByLine = new Map(lines.map((line) => [line.id, 0]));
  const allocations: OrderEditDiscountAllocation[] = [];
  const discounts: OrderEditDiscount[] = [];
  const unusedFixedCredits: OrderEditDiscountResult["unusedFixedCredits"] = [];
  const subtotal = sumOrderEditCents(lines.map((line) => line.subtotalCents));
  const byKey = (left: { key: string }, right: { key: string }): number =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  const percentages = rules
    .flatMap((rule) =>
      rule.value.type === "percentage" ? [{ ...rule, value: rule.value }] : [],
    )
    .sort(byKey);
  const fixed = rules
    .flatMap((rule) =>
      rule.value.type === "fixed" ? [{ ...rule, value: rule.value }] : [],
    )
    .sort(byKey);
  // Even on a one-cent item, independently rounded excessive percentages must
  // not disguise an invalid combination as a harmless rounding difference.
  const fractions = percentages.map((rule) => fraction(rule.value.percentage));
  // Decimal denominators are powers of ten. One common scale avoids multiplying
  // denominators repeatedly for a large number of accepted codes.
  const scale = fractions.reduce(
    (largest, ratio) =>
      ratio.denominator > largest ? ratio.denominator : largest,
    BigInt(1),
  );
  const combined = fractions.reduce(
    (total, ratio) => total + ratio.numerator * (scale / ratio.denominator),
    BigInt(0),
  );
  if (combined > scale)
    reject(
      "ORDER_EDIT_DISCOUNT_COMBINATION_INVALID",
      "The combined order percentages exceed 100 percent.",
    );
  for (const rule of percentages) {
    const amounts = lines.map((line) => {
      const range = roundedRange(line.subtotalCents, rule.value.percentage);
      const already = allocatedByLine.get(line.id)!;
      const amount =
        observations === undefined
          ? Math.min(range.nearest, line.subtotalCents - already)
          : (observed.get(allocationKey(line.id, rule.key)) ?? 0);
      if (amount < range.floor || amount > range.ceil)
        reject(
          "ORDER_EDIT_PERCENTAGE_DISCOUNT_MISMATCH",
          `The ${rule.label} allocation does not match its original percentage.`,
        );
      if (amount > line.subtotalCents - already)
        reject(
          "ORDER_EDIT_DISCOUNT_OVERALLOCATED",
          "Combined discounts exceed an item's eligible amount.",
        );
      allocatedByLine.set(line.id, already + amount);
      allocations.push({
        lineId: line.id,
        ruleKey: rule.key,
        amountCents: amount,
      });
      return amount;
    });
    discounts.push({
      key: rule.key,
      label: rule.label,
      value: rule.value,
      amountCents: sumOrderEditCents(amounts),
    });
  }
  let remaining =
    subtotal -
    sumOrderEditCents(discounts.map((discount) => discount.amountCents));
  const fixedTotal = sumOrderEditCents(
    fixed.map((rule) => rule.value.amountCents),
  );
  if (fixed.length > 1 && fixedTotal > remaining)
    reject(
      "ORDER_EDIT_FIXED_CREDIT_PRIORITY_REQUIRED",
      "Multiple fixed credits exceed the revised eligible total. Their unused credit needs explicit settlement priority.",
    );
  for (const rule of fixed) {
    const wanted = Math.min(rule.value.amountCents, remaining);
    const targets =
      observations === undefined
        ? allocateFixed(
            wanted,
            lines.map((line) => ({
              id: line.id,
              capacityCents: line.subtotalCents - allocatedByLine.get(line.id)!,
            })),
          )
        : null;
    const amounts = lines.map((line) => {
      const amount =
        targets?.get(line.id) ??
        observed.get(allocationKey(line.id, rule.key)) ??
        0;
      const already = allocatedByLine.get(line.id)!;
      if (amount > line.subtotalCents - already)
        reject(
          "ORDER_EDIT_DISCOUNT_OVERALLOCATED",
          "Combined discounts exceed an item's eligible amount.",
        );
      allocatedByLine.set(line.id, already + amount);
      allocations.push({
        lineId: line.id,
        ruleKey: rule.key,
        amountCents: amount,
      });
      return amount;
    });
    const actual = sumOrderEditCents(amounts);
    if (actual !== wanted)
      reject(
        "ORDER_EDIT_FIXED_DISCOUNT_MISMATCH",
        `The ${rule.label} fixed credit must stay ${rule.value.amountCents} cents across the order; Shopify allocated ${actual} cents instead of ${wanted}.`,
      );
    const unused = rule.value.amountCents - wanted;
    if (unused > 0)
      unusedFixedCredits.push({
        ruleKey: rule.key,
        label: rule.label,
        amountCents: unused,
      });
    discounts.push({
      key: rule.key,
      label: rule.label,
      value: rule.value,
      amountCents: actual,
    });
    remaining -= actual;
  }
  const orderDiscountCents = sumOrderEditCents(
    discounts.map((discount) => discount.amountCents),
  );
  return {
    subtotalBeforeOrderDiscountsCents: subtotal,
    orderDiscountCents,
    subtotalAfterOrderDiscountsCents: subtotal - orderDiscountCents,
    discounts,
    allocations,
    unusedFixedCredits,
  };
}
