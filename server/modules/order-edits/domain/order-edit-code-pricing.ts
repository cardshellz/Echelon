import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  orderEditCodePricingSchema,
  orderEditCodePricingLineSchema,
  type OrderEditCodeRule,
  type OrderEditCodePricing,
} from "@shared/order-edits/order-edit-codes";
import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";
import type { OrderEditDiscount } from "@shared/order-edits/order-edit-discounts";
import { priceOrderEditDiscounts } from "./order-edit-discount-engine";
import { sumOrderEditCents } from "./order-edit-financials";
import { OrderEditError } from "./order-edit-error";

export interface OrderEditCodePricingLine {
  id: string;
  variantId: string;
  quantity: number;
  grossCents: number;
  productNetCents: number;
  nativeDiscountCents?: number;
}

/** Reuses the order-wide percentage/fixed-credit engine after member/product pricing. */
export function priceOrderEditCodes(
  lines: OrderEditCodePricingLine[],
  rules: OrderEditCodeRule[],
  newCodes: string[],
  approvedAmounts?: Array<{ code: string; amountCents: number }>,
  retainedNativeDiscounts?: OrderEditDiscount[],
): OrderEditCodePricing {
  const priced = priceOrderEditDiscounts({
    ...(approvedAmounts
      ? {
          approvedTotals: approvedAmounts.map((amount) => ({
            ruleKey: `code:${amount.code}`,
            amountCents: amount.amountCents,
          })),
        }
      : {}),
    rules: rules.map((rule) => ({
      key: `code:${rule.code}`,
      label: rule.code,
      value: rule.value,
    })),
    lines: lines.map((line) => ({
      id: line.id,
      subtotalCents: line.productNetCents - (line.nativeDiscountCents ?? 0),
    })),
  });
  if (
    rules.some(
      (rule) =>
        ["single_use_reward", "club_reward"].includes(rule.redemption) &&
        (rule.value.type !== "fixed" ||
          priced.discounts.find((discount) => discount.label === rule.code)
            ?.amountCents !== rule.value.amountCents),
    ) ||
    priced.unusedFixedCredits.some((credit) =>
      rules.some(
        (rule) =>
          `code:${rule.code}` === credit.ruleKey &&
          ["single_use_reward", "club_reward"].includes(rule.redemption),
      ),
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_UNUSED_CREDIT",
      "This order cannot use the full rewards credit. Remove the code or add enough eligible items; no points have been used.",
    );
  if (priced.discounts.some((discount) => discount.amountCents === 0))
    throw new OrderEditError(
      "ORDER_EDIT_CODE_NO_SAVING",
      "This code does not reduce the price of these items. No code was applied.",
    );
  // Short, deterministic native description binds the manual prices to persisted, verified terms.
  const digest = createHash("sha256")
    .update(canonicalJson(rules))
    .digest("hex")
    .slice(0, 24);
  return orderEditCodePricingSchema.parse({
    rules,
    newCodes,
    ...(retainedNativeDiscounts?.length ? { retainedNativeDiscounts } : {}),
    description: `Order discounts (${digest})`,
    applications: priced.discounts.map((discount) => ({
      code: discount.label,
      amountCents: discount.amountCents,
    })),
    lines: lines.map((line) => ({
      id: line.id,
      sourceId: line.id,
      variantId: line.variantId,
      quantity: line.quantity,
      retailCents: exactUnit(line.grossCents, line.quantity),
      productNetCents: line.productNetCents,
      ...(line.nativeDiscountCents
        ? { nativeDiscountCents: line.nativeDiscountCents }
        : {}),
      netCents:
        line.productNetCents -
        (line.nativeDiscountCents ?? 0) -
        sumOrderEditCents(
          priced.allocations
            .filter((a) => a.lineId === line.id)
            .map((a) => a.amountCents),
        ),
    })),
  });
}

function exactUnit(total: number, quantity: number): number {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    BigInt(total) % BigInt(quantity) !== BigInt(0)
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_PRICING_INVALID",
      "The item's original unit price could not be verified.",
    );
  return Number(BigInt(total) / BigInt(quantity));
}

/** Allocate an exact line total into at most two uniform-cent native rows. No money is rounded away. */
export function splitOrderEditCodeLine(
  line: OrderEditCodePricing["lines"][number],
) {
  const parsed = orderEditCodePricingLineSchema.parse(line);
  // Shopify refuses a manual discount on an original checkout-discounted row.
  // Keep that row and its allocation intact, including uneven native pennies.
  if (parsed.nativeDiscountCents) {
    if (parsed.netCents !== parsed.productNetCents - parsed.nativeDiscountCents)
      throw new OrderEditError(
        "ORDER_EDIT_CODE_NATIVE_ALLOCATION_CHANGED",
        "The original reward allocation must stay on its original items. Your order has not changed.",
      );
    return [
      {
        quantity: parsed.quantity,
        unitCents: parsed.retailCents,
        productNetCents: parsed.productNetCents,
        netCents: parsed.netCents,
      },
    ];
  }
  const quantity = BigInt(parsed.quantity);
  const unit = BigInt(parsed.netCents) / quantity;
  const remainder = Number(BigInt(parsed.netCents) % quantity);
  const groups = [
    { quantity: parsed.quantity - remainder, unitCents: Number(unit) },
    ...(remainder
      ? [{ quantity: remainder, unitCents: Number(unit + BigInt(1)) }]
      : []),
  ];
  // Product/member price is recorded separately; the full line budget survives subsequent edits.
  const productUnitCents = exactUnit(parsed.productNetCents, parsed.quantity);
  return groups.map((group) => {
    const productNetCents = Number(
      BigInt(productUnitCents) * BigInt(group.quantity),
    );
    return {
      ...group,
      productNetCents,
      netCents: Number(BigInt(group.quantity) * BigInt(group.unitCents)),
    };
  });
}

/** Only presentation/provisional pricing is enriched. Native identity fingerprints remain untouched. */
export function presentOrderEditCodeFinancials(
  financials: OrderEditFinancials,
  pricing: OrderEditCodePricing,
): OrderEditFinancials {
  const productCents = sumOrderEditCents(
    pricing.lines.map((line) =>
      Number(
        BigInt(line.retailCents) * BigInt(line.quantity) -
          BigInt(line.productNetCents),
      ),
    ),
  );
  const discounts = [
    ...(pricing.retainedNativeDiscounts ?? []),
    ...pricing.applications.map((application) => ({
      key: `code:${application.code}`,
      label: application.code,
      amountCents: application.amountCents,
      value: pricing.rules.find((rule) => rule.code === application.code)!
        .value,
    })),
    ...(productCents
      ? [
          {
            key: "product",
            label: "Product discounts",
            amountCents: productCents,
            value: { type: "allocated" as const },
          },
        ]
      : []),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (
    sumOrderEditCents(discounts.map((discount) => discount.amountCents)) !==
      financials.itemsDiscountCents ||
    sumOrderEditCents(pricing.lines.map((line) => line.netCents)) !==
      financials.itemsNetCents
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_FINANCIAL_MISMATCH",
      "The code savings do not match Shopify's order amounts. The order remains held for review.",
    );
  return {
    ...financials,
    itemDiscounts: discounts,
    itemDiscountLabels: discounts.map((discount) => discount.label),
  };
}
