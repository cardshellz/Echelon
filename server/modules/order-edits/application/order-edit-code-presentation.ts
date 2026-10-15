import type { OrderEditSnapshot } from "./order-edit-provider";
import type { OrderEditCodePricing } from "@shared/order-edits/order-edit-codes";
import { presentOrderEditCodeFinancials } from "../domain/order-edit-code-pricing";
import { OrderEditError } from "../domain/order-edit-error";
import {
  orderEditFinancialsSchema,
  type OrderEditFinancials,
} from "@shared/order-edits/order-edit-financials";

/** API-only decoration: never add display fields to persisted financial proof or fingerprints. */
export function presentOrderEditCodeBreakdown(
  financials: OrderEditFinancials | undefined,
  pricing: OrderEditCodePricing | undefined,
): OrderEditFinancials | undefined {
  if (!financials || !pricing) return financials;
  const byId = new Map(pricing.lines.map((line) => [line.id, line]));
  const presented = orderEditFinancialsSchema.safeParse({
    ...financials,
    orderDiscounts: pricing.applications.map((application) => ({
      key: `code:${application.code}`,
      label: application.code,
      amountCents: application.amountCents,
      value: pricing.rules.find((rule) => rule.code === application.code)
        ?.value,
    })),
    lines: financials.lines.map((line) => {
      const priced = byId.get(line.id);
      return {
        ...line,
        // Native edit rows may split a product to allocate an uneven coupon.
        // Match their exact IDs; never redistribute money from a group total.
        productNetCents:
          priced?.netCents === line.netCents
            ? priced.productNetCents
            : !priced && line.grossCents === 0 && line.netCents === 0
              ? 0
              : undefined,
      };
    }),
  });
  if (
    byId.size !== pricing.lines.length ||
    pricing.lines.some(
      (line) => !financials.lines.some((item) => item.id === line.id),
    ) ||
    !presented.success
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_PRESENTATION_INVALID",
      "The item prices and order discount could not be verified. Refresh the order before continuing.",
    );
  return presented.data;
}

/** Enrich verified pricing evidence without changing native identity fingerprints. */
export function withOrderEditCodePricing(
  snapshot: OrderEditSnapshot,
  pricing: OrderEditCodePricing,
): OrderEditSnapshot {
  if (!snapshot.financials)
    throw new OrderEditError(
      "ORDER_EDIT_CODE_FINANCIAL_MISSING",
      "The complete order amounts are required to verify its codes.",
    );
  return {
    ...snapshot,
    codePricing: pricing,
    financials: presentOrderEditCodeFinancials(snapshot.financials, pricing),
    previewProductDiscounts: pricing.lines.map((line) => ({
      lineId: line.id,
      amountCents: Number(
        BigInt(line.retailCents) * BigInt(line.quantity) -
          BigInt(line.productNetCents),
      ),
      automaticCents: 0,
    })),
  };
}
