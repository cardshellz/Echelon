import { z } from "zod";
import { OrderEditError } from "./order-edit-error";
import { sumOrderEditCents } from "./order-edit-financials";
import {
  priceOrderEditDiscounts,
  type OrderEditDiscountEngineInput,
  type OrderEditDiscountResult,
} from "./order-edit-discount-engine";

const cents = z.number().int().safe().nonnegative();
const id = z.string().min(1).max(500);
export const preservedDiscountAllocationSchema = z
  .object({
    lineId: id,
    ruleKey: id,
    amountCents: cents,
  })
  .strict();
const inputSchema = z
  .object({
    rules: z.array(z.object({ key: id, label: id }).strict()).max(250),
    originals: z.array(z.object({ id, quantity: cents }).strict()).max(250),
    allocations: z.array(preservedDiscountAllocationSchema).max(62500),
    lines: z
      .array(
        z
          .object({
            id,
            originalLineId: id.nullable(),
            quantity: cents,
            subtotalCents: cents,
          })
          .strict(),
      )
      .max(250),
    observations: z
      .array(preservedDiscountAllocationSchema)
      .max(62500)
      .optional(),
  })
  .strict();

function fail(message: string): never {
  throw new OrderEditError("ORDER_EDIT_PRESERVED_DISCOUNT_MISMATCH", message);
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length)
    fail("Original discount evidence contains duplicate identities.");
}
const key = (lineId: string, ruleKey: string) =>
  JSON.stringify([lineId, ruleKey]);

/** Shopify retains fixed checkout allocations on original items. A code's issued
 * value is not a new budget for added merchandise, even after an unused-points
 * settlement. Extra units are separate additions, never another redemption. */
export function pricePreservedOrderDiscounts(
  raw: z.infer<typeof inputSchema>,
): OrderEditDiscountResult {
  const input = inputSchema.parse(raw);
  unique(input.rules.map((rule) => rule.key));
  unique(input.originals.map((line) => line.id));
  unique(input.lines.map((line) => line.id));
  unique(
    input.lines.flatMap((line) =>
      line.originalLineId ? [line.originalLineId] : [],
    ),
  );
  unique(
    input.allocations.map((allocation) =>
      key(allocation.lineId, allocation.ruleKey),
    ),
  );
  const rules = new Set(input.rules.map((rule) => rule.key));
  const originals = new Map(input.originals.map((line) => [line.id, line]));
  for (const allocation of input.allocations)
    if (!rules.has(allocation.ruleKey) || !originals.has(allocation.lineId))
      fail("An original allocation references an unknown item or discount.");
  const allocations = input.lines.flatMap((line) => {
    if (!line.originalLineId) return [];
    const original = originals.get(line.originalLineId);
    if (!original) fail("A revised item references an unknown original item.");
    return input.allocations
      .filter((entry) => entry.lineId === original.id)
      .map((entry) => {
        const numerator = BigInt(entry.amountCents) * BigInt(line.quantity);
        if (
          !original.quantity ||
          line.quantity > original.quantity ||
          numerator % BigInt(original.quantity) !== BigInt(0)
        )
          fail(
            "The original discount cannot be preserved at the selected quantity.",
          );
        return {
          lineId: line.id,
          ruleKey: entry.ruleKey,
          amountCents: Number(numerator / BigInt(original.quantity)),
        };
      });
  });
  for (const line of input.lines) {
    const discount = sumOrderEditCents(
      allocations.filter((a) => a.lineId === line.id).map((a) => a.amountCents),
    );
    if (discount > line.subtotalCents)
      fail("An original discount exceeds the item's merchandise amount.");
  }
  if (input.observations) {
    unique(input.observations.map((a) => key(a.lineId, a.ruleKey)));
    const expected = new Map(
      allocations.map((a) => [key(a.lineId, a.ruleKey), a.amountCents]),
    );
    const observed = new Map(
      input.observations.map((a) => [key(a.lineId, a.ruleKey), a.amountCents]),
    );
    if (
      input.observations.some(
        (a) =>
          !rules.has(a.ruleKey) ||
          !input.lines.some((line) => line.id === a.lineId),
      ) ||
      [...new Set([...expected.keys(), ...observed.keys()])].some(
        (id) => (expected.get(id) ?? 0) !== (observed.get(id) ?? 0),
      )
    )
      fail("Shopify changed an original discount allocation during the edit.");
  }
  const subtotalBeforeOrderDiscountsCents = sumOrderEditCents(
    input.lines.map((line) => line.subtotalCents),
  );
  const orderDiscountCents = sumOrderEditCents(
    allocations.map((a) => a.amountCents),
  );
  return {
    subtotalBeforeOrderDiscountsCents,
    orderDiscountCents,
    subtotalAfterOrderDiscountsCents:
      subtotalBeforeOrderDiscountsCents - orderDiscountCents,
    allocations,
    unusedFixedCredits: [],
    discounts: input.rules.map((rule) => ({
      ...rule,
      amountCents: sumOrderEditCents(
        allocations
          .filter((a) => a.ruleKey === rule.key)
          .map((a) => a.amountCents),
      ),
      value: { type: "allocated" as const },
    })),
  };
}

/** Native percentage codes recalculate for added items; native fixed codes
 * retain their original line allocations. Verified separately in Shopify. */
export function priceRetainedOrderDiscounts(
  input: Omit<z.infer<typeof inputSchema>, "rules"> & {
    rules: OrderEditDiscountEngineInput["rules"];
  },
): OrderEditDiscountResult {
  const percentageRules = input.rules.filter(
    (rule) => rule.value.type === "percentage",
  );
  const fixedRules = input.rules.filter((rule) => rule.value.type === "fixed");
  const percentageKeys = new Set(percentageRules.map((rule) => rule.key));
  const percentages = priceOrderEditDiscounts({
    rules: percentageRules,
    lines: input.lines.map((line) => ({
      id: line.id,
      subtotalCents: line.subtotalCents,
    })),
    observations: input.observations?.filter((entry) =>
      percentageKeys.has(entry.ruleKey),
    ),
  });
  const fixed = pricePreservedOrderDiscounts({
    ...input,
    rules: fixedRules.map(({ key, label }) => ({ key, label })),
    allocations: input.allocations.filter(
      (entry) => !percentageKeys.has(entry.ruleKey),
    ),
    observations: input.observations?.filter(
      (entry) => !percentageKeys.has(entry.ruleKey),
    ),
    lines: input.lines.map((line) => ({
      ...line,
      subtotalCents:
        line.subtotalCents -
        sumOrderEditCents(
          percentages.allocations
            .filter((a) => a.lineId === line.id)
            .map((a) => a.amountCents),
        ),
    })),
  });
  return {
    subtotalBeforeOrderDiscountsCents:
      percentages.subtotalBeforeOrderDiscountsCents,
    subtotalAfterOrderDiscountsCents: fixed.subtotalAfterOrderDiscountsCents,
    orderDiscountCents: sumOrderEditCents([
      percentages.orderDiscountCents,
      fixed.orderDiscountCents,
    ]),
    allocations: [...percentages.allocations, ...fixed.allocations],
    discounts: [
      ...percentages.discounts,
      ...fixed.discounts.map((discount) => {
        const rule = fixedRules.find((entry) => entry.key === discount.key)!;
        return {
          ...discount,
          value:
            rule.value.type === "fixed" &&
            rule.value.amountCents === discount.amountCents
              ? rule.value
              : discount.value,
        };
      }),
    ],
    unusedFixedCredits: [],
  };
}
