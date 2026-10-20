import type { OrderEditSnapshot, OrderEditQuote } from "./order-edit-provider";
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
  productLines?: Array<{ id: string; productNetCents: number }>,
): OrderEditFinancials | undefined {
  if (!financials) return financials;
  if (!pricing) {
    const discounts = financials.itemDiscounts?.filter((entry) =>
      entry.key.startsWith("code:"),
    );
    if (!productLines || !discounts?.length) return financials;
    const byId = new Map(
      productLines.map((line) => [line.id, line.productNetCents]),
    );
    const presented = orderEditFinancialsSchema.safeParse({
      ...financials,
      orderDiscounts: discounts,
      lines: financials.lines.map((line) => ({
        ...line,
        productNetCents: byId.get(line.id),
      })),
    });
    if (byId.size !== productLines.length || !presented.success)
      throw new OrderEditError(
        "ORDER_EDIT_CODE_PRESENTATION_INVALID",
        "The original item prices and order discount could not be verified.",
      );
    return presented.data;
  }
  const byId = new Map(pricing.lines.map((line) => [line.id, line]));
  const presented = orderEditFinancialsSchema.safeParse({
    ...financials,
    orderDiscounts: [
      ...(pricing.retainedNativeDiscounts ?? []),
      ...pricing.applications.map((application) => ({
        key: `code:${application.code}`,
        label: application.code,
        amountCents: application.amountCents,
        value: pricing.rules.find((rule) => rule.code === application.code)
          ?.value,
      })),
    ],
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

export function snapshotProductPrices(snapshot: OrderEditSnapshot) {
  if (!snapshot.previewProductDiscounts || !snapshot.financials)
    return undefined;
  return snapshot.financials.lines.map((line) => ({
    id: line.id,
    productNetCents:
      line.grossCents -
      (snapshot.previewProductDiscounts!.find(
        (entry) => entry.lineId === line.id,
      )?.amountCents ?? 0),
  }));
}

export function quoteProductPrices(quote: OrderEditQuote | null) {
  if (!quote?.baseline.previewProductDiscounts) return undefined;
  return quote.lines.map((line) => {
    if (line.quantity === 0)
      return { id: line.calculatedLineId, productNetCents: 0 };
    const original = quote.baseline.lines.find(
      (entry) => entry.id === line.originalLineId,
    );
    const discount = quote.baseline.previewProductDiscounts!.find(
      (entry) => entry.lineId === line.originalLineId,
    );
    if (!original || !discount)
      return { id: line.calculatedLineId, productNetCents: line.totalCents };
    const numerator = BigInt(discount.amountCents) * BigInt(line.quantity);
    if (
      original.quantity <= 0 ||
      numerator % BigInt(original.quantity) !== BigInt(0)
    )
      throw new OrderEditError(
        "ORDER_EDIT_CODE_PRESENTATION_INVALID",
        "The original item price cannot be displayed exactly.",
      );
    return {
      id: line.calculatedLineId,
      productNetCents: Number(
        BigInt(line.originalUnitPriceCents) * BigInt(line.quantity) -
          numerator / BigInt(original.quantity),
      ),
    };
  });
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
  const automaticByLine = new Map(
    snapshot.previewProductDiscounts?.map((line) => [
      line.lineId,
      line.automaticCents,
    ]),
  );
  if (
    pricing.lines.some(
      (line) =>
        line.preserveAutomaticDiscount &&
        !(
          Number.isSafeInteger(automaticByLine.get(line.id)) &&
          automaticByLine.get(line.id)! > 0
        ),
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_AUTOMATIC_EVIDENCE_MISSING",
      "The existing automatic discount could not be verified. Refresh the order before continuing.",
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
      automaticCents: line.preserveAutomaticDiscount
        ? automaticByLine.get(line.id)!
        : 0,
    })),
  };
}
