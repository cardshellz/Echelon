import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";

type FinancialResponse = {
  financials?:
    | OrderEditFinancials
    | {
        before: OrderEditFinancials | null;
        quoted: OrderEditFinancials | null;
        current: OrderEditFinancials | null;
      };
};

function legacyFinancials(
  financials: OrderEditFinancials,
): OrderEditFinancials {
  const { orderDiscounts: _discounts, ...legacy } = financials;
  return {
    ...legacy,
    lines: legacy.lines.map(({ productNetCents: _subtotal, ...line }) => line),
  };
}

/** Old tabs use strict schemas. Project only the API response, never financial evidence. */
export function orderEditResponsePresentation<T extends FinancialResponse>(
  response: T,
  enabled: boolean,
): T {
  if (enabled || !response.financials) return response;
  const financials = response.financials;
  return {
    ...response,
    financials:
      "itemsNetCents" in financials
        ? legacyFinancials(financials)
        : {
            before: financials.before && legacyFinancials(financials.before),
            quoted: financials.quoted && legacyFinancials(financials.quoted),
            current: financials.current && legacyFinancials(financials.current),
          },
  };
}
