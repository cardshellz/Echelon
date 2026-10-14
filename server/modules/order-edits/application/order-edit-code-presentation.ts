import type { OrderEditSnapshot } from "./order-edit-provider";
import type { OrderEditCodePricing } from "@shared/order-edits/order-edit-codes";
import { presentOrderEditCodeFinancials } from "../domain/order-edit-code-pricing";
import { OrderEditError } from "../domain/order-edit-error";

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
